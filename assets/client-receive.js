/*
 * Copyright (C) 2025 adnihilum authors
 *
 * This file is part of adnihilum.
 *
 * adnihilum is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * adnihilum is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with adnihilum.  If not, see <https://www.gnu.org/licenses/>.
 */
// SPDX-License-Identifier: GPL-3.0-or-later

(function () {
	const shared = window.AdNihilumShared;

	function setViewerText(message, tone = '') {
		const textField = shared.$('text');
		if (!textField)
			return;
		textField.classList.remove('receive-state-info', 'receive-state-error');
		if (tone === 'info' || tone === 'error')
			textField.classList.add('receive-state-' + tone);
		textField.value = message;
		textField.dispatchEvent(new Event('input', { bubbles: true }));
		syncCopyButtonState();
	}

	function friendlyReceiveError(err) {
		const message = err && err.message ? err.message : String(err || '');
		if (err && err.name === 'IdMismatchError')
			return 'This link looks broken or incomplete.';
		if (/Invalid base64 data|Key length mismatch|ID length mismatch/i.test(message))
			return 'This link looks broken or incomplete.';
		if (/GET .* (404|410)\b/i.test(message))
			return 'This secret is no longer available. It may have already been opened or expired.';
		if (/Blob is too small|Unsupported blob type|Decrypted payload missing type tag/i.test(message))
			return 'This secret could not be opened. The link may be damaged.';
		if (/Failed to prepare password protected payload/i.test(message))
			return 'This secret could not be prepared for decryption.';
		return 'Could not open the secret. Try opening the full link again.';
	}

	function syncCopyButtonState() {
		const textField = shared.$('text');
		const copyBtn = shared.$('copySecretBtn');
		if (!textField || !copyBtn)
			return;
		copyBtn.disabled = !textField.value;
	}

	async function tryToReceiveSecret() {
		const info = shared.parseLocationHash(window.location.hash || '');
		if (!info) {
			setViewerText('Open a full secret link to view a message.', 'info');
			return;
		}

		shared.clearLocationHash();
		shared.clearPendingSecret();
		shared.lockTextarea(true);
		setViewerText('Receiving secret...', 'info');

		let keyBytes = null;
		let buf = null;
		let plaintextBytes = null;
		let idBytes = null;
		let derivedIdBytes = null;

		try {
			const origin = shared.getOrigin();
			keyBytes = shared.base64UrlDecode(info.bK);
			if (keyBytes.length !== shared.KEY_SIZE)
				throw new Error('Key length mismatch');
			idBytes = shared.base64UrlDecode(info.id);
			if (!idBytes || idBytes.length !== shared.ID_SIZE)
				throw new Error('ID length mismatch');

			const url = shared.normalizeOrigin(origin) + '/blob/' +
				shared.bytesToHex(idBytes);
			const res = await fetch(url);
			if (!res.ok) {
				const responseText = await shared.safeText(res);
				throw new Error(`GET ${url} ${res.status}: ${responseText || res.statusText}`);
			}

			buf = new Uint8Array(await res.arrayBuffer());
			if (buf.length <= shared.NONCE_SIZE + shared.SALT_SIZE +
				shared.BLOB_TYPE_SIZE) {
				throw new Error('Blob is too small');
			}

			const nonce = buf.subarray(0, shared.NONCE_SIZE);
			const salt = buf.subarray(
				shared.NONCE_SIZE,
				shared.NONCE_SIZE + shared.SALT_SIZE);
			const ciphertext = buf.subarray(shared.NONCE_SIZE + shared.SALT_SIZE);

			derivedIdBytes = await shared.deriveIdFromKeyAndSalt(keyBytes, salt);
			if (!shared.equal16B(derivedIdBytes, idBytes)) {
				const derivedIdBase64Url = shared.base64UrlEncode(derivedIdBytes);
				const err = new Error(
					`ID mismatch: derived ID' (${derivedIdBase64Url}) !== provided ID (${info.id}).`);
				err.name = 'IdMismatchError';
				err.derivedId = derivedIdBase64Url;
				err.providedId = info.id;
				throw err;
			}

			const aesKey = await crypto.subtle.importKey(
				'raw',
				keyBytes,
				{ name: 'AES-GCM', length: shared.KEY_SIZE * 8 },
				false,
				['decrypt']);
			const aad = shared.encoder.encode('id=' + info.id);
			plaintextBytes = new Uint8Array(await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: nonce, additionalData: aad },
				aesKey,
				ciphertext));

			if (plaintextBytes.length < shared.BLOB_TYPE_SIZE)
				throw new Error('Decrypted payload missing type tag');

			const blobTypeTagValue = (plaintextBytes[0] << 8) |
				plaintextBytes[1];
			const passwordProtected = blobTypeTagValue ===
				shared.BLOB_TYPE_PASSWORD_VALUE;
			if (!passwordProtected &&
				blobTypeTagValue !== shared.BLOB_TYPE_TEXT_VALUE) {
				throw new Error('Unsupported blob type');
			}

			const payloadBytes = plaintextBytes.subarray(shared.BLOB_TYPE_SIZE);
			if (passwordProtected) {
				const nonceCopy = shared.cloneBytes(nonce);
				const saltCopy = shared.cloneBytes(salt);
				const ciphertextCopy = shared.cloneBytes(payloadBytes);
				if (!nonceCopy || !saltCopy || !ciphertextCopy) {
					throw new Error('Failed to prepare password protected payload');
				}

				shared.state.pendingSecret = {
					id: info.id,
					nonce: nonceCopy,
					salt: saltCopy,
					ciphertext: ciphertextCopy,
				};
				plaintextBytes.fill(0);
				plaintextBytes = null;
				setViewerText('');
				shared.setDecryptionCardVisible(true);
				const passwordField = shared.$('decryptionPassword');
				if (passwordField) {
					passwordField.value = '';
					passwordField.focus();
				}
				return;
			}

			const textField = shared.$('text');
			if (!textField)
				return;
			setViewerText(shared.decoder.decode(payloadBytes));
		} catch (err) {
			console.error(err);
			shared.setDecryptionCardVisible(false);
			setViewerText(friendlyReceiveError(err), 'error');
			shared.clearPendingSecret();
		} finally {
			if (plaintextBytes)
				plaintextBytes.fill(0);
			if (keyBytes)
				keyBytes.fill(0);
			if (idBytes)
				idBytes.fill(0);
			if (derivedIdBytes)
				derivedIdBytes.fill(0);
			if (buf)
				buf.fill(0);
			shared.lockTextarea(false);
		}
	}

	async function decryptPendingSecretWithPassword() {
		const pending = shared.state.pendingSecret;
		if (!pending || !pending.ciphertext) {
			setViewerText('There is no secret waiting for password decryption.',
				'error');
			return;
		}

		const passwordField = shared.$('decryptionPassword');
		if (!passwordField)
			return;

		const passwordValue = passwordField.value;
		if (!passwordValue) {
			passwordField.focus();
			return;
		}

		let plaintextBytes = null;
		let decrypted = false;

		try {
			setViewerText('Receiving secret...', 'info');
			const passwordKey = await shared.derivePasswordKey(
				passwordValue,
				pending.salt,
				['decrypt']);
			const aad = shared.encoder.encode('id=' + pending.id);
			plaintextBytes = new Uint8Array(await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: pending.nonce,
					additionalData: aad
				},
				passwordKey,
				pending.ciphertext));
			const textField = shared.$('text');
			if (!textField)
				return;

			setViewerText(shared.decoder.decode(plaintextBytes));
			passwordField.value = '';
			shared.setDecryptionCardVisible(false);
			decrypted = true;
		} catch (err) {
			console.error(err);
			setViewerText('That password did not work. Check it and try again.',
				'error');
			passwordField.select();
			passwordField.focus();
		} finally {
			if (decrypted)
				shared.clearPendingSecret();
			if (plaintextBytes)
				plaintextBytes.fill(0);
		}
	}

	function init() {
		const decryptBtn = shared.$('decryptBtn');
		const passwordField = shared.$('decryptionPassword');
		const copyBtn = shared.$('copySecretBtn');
		const textField = shared.$('text');

		if (decryptBtn) {
			decryptBtn.addEventListener('click',
				() => { void decryptPendingSecretWithPassword(); });
		}
		if (passwordField) {
			passwordField.addEventListener('keydown', (event) => {
				if (event.key === 'Enter') {
					event.preventDefault();
					void decryptPendingSecretWithPassword();
				}
			});
		}
		if (copyBtn) {
			const defaultCopyLabel = copyBtn.textContent;
			copyBtn.addEventListener('click', () => {
				void (async function () {
					const currentText = shared.$('text');
					if (!currentText || !currentText.value ||
						currentText.classList.contains('receive-state-error') ||
						currentText.classList.contains('receive-state-info')) {
						return;
					}
					try {
						await navigator.clipboard.writeText(currentText.value);
						copyBtn.textContent = 'Copied';
						setTimeout(() => {
							copyBtn.textContent = defaultCopyLabel;
						}, 1200);
					} catch (err) {
						console.error(err);
						copyBtn.textContent = 'Copy failed';
						setTimeout(() => {
							copyBtn.textContent = defaultCopyLabel;
						}, 1200);
					}
				})();
			});
		}
		if (textField) {
			textField.addEventListener('input', syncCopyButtonState);
			syncCopyButtonState();
		}

		void tryToReceiveSecret();
	}

	window.AdNihilumReceive = { init };
})();
