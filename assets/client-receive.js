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

	async function tryToReceiveSecret() {
		const info = shared.parseLocationHash(window.location.hash || '');
		if (!info)
			return;
		shared.clearLocationHash();
		shared.clearPendingSecret();
		shared.lockTextarea(true);
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
			shared.setStatus('Fetching secret…');
			const url = shared.normalizeOrigin(origin) + '/blob/' +
				shared.bytesToHex(idBytes);
			const res = await fetch(url);
			if (!res.ok) {
				const t = await shared.safeText(res);
				throw new Error(`GET ${url} ${res.status}: ${t || res.statusText}`);
			}
			buf = new Uint8Array(await res.arrayBuffer());
			if (buf.length <= shared.NONCE_SIZE + shared.SALT_SIZE +
				shared.BLOB_TYPE_SIZE) {
				throw new Error('Blob is too small');
			}

			const nonce = buf.subarray(0, shared.NONCE_SIZE);
			const salt = buf.subarray(shared.NONCE_SIZE,
				shared.NONCE_SIZE + shared.SALT_SIZE);
			const ct = buf.subarray(shared.NONCE_SIZE + shared.SALT_SIZE);

			derivedIdBytes = await shared.deriveIdFromKeyAndSalt(keyBytes, salt);
			if (!shared.equal16B(derivedIdBytes, idBytes)) {
				const derivedIdBase64Url =
					shared.base64UrlEncode(derivedIdBytes);
				const err = new Error(
					`ID mismatch: derived ID' (${derivedIdBase64Url}) !== provided ID (${info.id}).`);
				err.name = 'IdMismatchError';
				err.derivedId = derivedIdBase64Url;
				err.providedId = info.id;
				throw err;
			}

			const aesKey = await crypto.subtle.importKey(
				'raw', keyBytes,
				{ name: 'AES-GCM', length: shared.KEY_SIZE * 8 }, false,
				['decrypt']);
			const aad = shared.encoder.encode('id=' + info.id);
			plaintextBytes = new Uint8Array(await crypto.subtle.decrypt(
				{ name: 'AES-GCM', iv: nonce, additionalData: aad },
				aesKey, ct));
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
					throw new Error(
						'Failed to prepare password protected payload');
				}
				shared.state.pendingSecret = {
					id: info.id,
					nonce: nonceCopy,
					salt: saltCopy,
					ciphertext: ciphertextCopy,
				};
				plaintextBytes.fill(0);
				plaintextBytes = null;
				shared.setDecryptionCardVisible(true);
				shared.setStatus('Password required to decrypt this secret.',
					false);
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
			textField.value = shared.decoder.decode(payloadBytes);
			textField.dispatchEvent(new Event('input', { bubbles: true }));
			shared.setStatus('Secret retrieved and decrypted.', true);
		} catch (err) {
			console.error(err);
			shared.setDecryptionCardVisible(false);
			shared.setStatus(err.message || String(err));
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
			shared.setStatus('No secret waiting for password decryption.', false);
			return;
		}
		const passwordField = shared.$('decryptionPassword');
		if (!passwordField)
			return;
		const passwordValue = passwordField.value;
		if (!passwordValue) {
			shared.setStatus('Enter the password to decrypt this secret.', false);
			passwordField.focus();
			return;
		}
		let plaintextBytes = null;
		let decrypted = false;
		try {
			shared.setStatus('Decrypting secret with provided password…');
			const passwordKey = await shared.derivePasswordKey(
				passwordValue, pending.salt, ['decrypt']);
			const aad = shared.encoder.encode('id=' + pending.id);
			plaintextBytes = new Uint8Array(await crypto.subtle.decrypt(
				{
					name: 'AES-GCM',
					iv: pending.nonce,
					additionalData: aad
				},
				passwordKey, pending.ciphertext));
			const textField = shared.$('text');
			if (!textField)
				return;
			textField.value = shared.decoder.decode(plaintextBytes);
			textField.dispatchEvent(new Event('input', { bubbles: true }));
			passwordField.value = '';
			shared.setStatus('Secret decrypted with the provided password.', true);
			shared.setDecryptionCardVisible(false);
			decrypted = true;
		} catch (err) {
			console.error(err);
			shared.setStatus('Could not decrypt with that password.', false);
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
		void tryToReceiveSecret();
	}

	window.AdNihilumReceive = { init };
})();
