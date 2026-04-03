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

	async function sendSecret(autoCopy = false) {
		shared.setStatus('');
		shared.clearPendingSecret();
		shared.lockTextarea(true);
		let keyBytes = null;
		let nonce = null;
		let salt = null;
		let idBytes = null;
		let payload = null;
		let taggedPayload = null;
		let ciphertext = null;
		let blob = null;
		let idBase64Url = null;
		try {
			const origin = shared.getOrigin();
			const textField = shared.$('text');
			const passwordInput = shared.$('optionalPassword');
			if (!textField || !passwordInput)
				return;
			const passwordValue = passwordInput.value;
			const hasPassword = typeof passwordValue === 'string' &&
				passwordValue.length > 0;
			payload = shared.encoder.encode(textField.value);
			keyBytes = crypto.getRandomValues(new Uint8Array(shared.KEY_SIZE));
			nonce = crypto.getRandomValues(new Uint8Array(shared.NONCE_SIZE));
			salt = crypto.getRandomValues(new Uint8Array(shared.SALT_SIZE));
			idBytes = await shared.deriveIdFromKeyAndSalt(keyBytes, salt);
			idBase64Url = shared.base64UrlEncode(idBytes);
			const aad = shared.encoder.encode('id=' + idBase64Url);
			if (hasPassword) {
				const passwordKey = await shared.derivePasswordKey(
					passwordValue, salt, ['encrypt']);
				const wrappedBuffer = await crypto.subtle.encrypt(
					{
						name: 'AES-GCM',
						iv: nonce,
						additionalData: aad
					},
					passwordKey, payload);
				payload.fill(0);
				payload = new Uint8Array(wrappedBuffer);
			}
			const tagBytes = hasPassword ? shared.BLOB_TYPE_PASSWORD :
				shared.BLOB_TYPE_TEXT;
			taggedPayload = new Uint8Array(shared.BLOB_TYPE_SIZE + payload.length);
			taggedPayload.set(tagBytes, 0);
			taggedPayload.set(payload, shared.BLOB_TYPE_SIZE);
			const aesKey = await crypto.subtle.importKey(
				'raw', keyBytes,
				{ name: 'AES-GCM', length: shared.KEY_SIZE * 8 }, false,
				['encrypt']);
			ciphertext = new Uint8Array(await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: nonce, additionalData: aad },
				aesKey, taggedPayload));

			taggedPayload.fill(0);
			taggedPayload = null;

			payload.fill(0);
			payload = null;

			blob = new Uint8Array(nonce.length + salt.length +
				ciphertext.length);
			blob.set(nonce, 0);
			blob.set(salt, nonce.length);
			blob.set(ciphertext, nonce.length + salt.length);
			if (blob.length > shared.BLOB_SIZE_MAX - 100) {
				shared.setStatus(
					'Secret is too large. Maximum size is ' +
					(shared.BLOB_SIZE_MAX / 1024 - 1) + ' KiB.',
					false);
				return;
			}
			const url = shared.normalizeOrigin(origin) + '/blob/' +
				shared.bytesToHex(idBytes);
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/octet-stream' },
				body: blob,
			});
			if (!res.ok) {
				const t = await shared.safeText(res);
				throw new Error(`POST ${url} ${res.status}: ${t || res.statusText}`);
			}
			passwordInput.value = '';

			const keyBase64Url = shared.base64UrlEncode(keyBytes);
			shared.setLink(origin, idBase64Url, keyBase64Url);
			const passwordNote =
				hasPassword ?
					' This secret requires the password you set during creation.' :
					'';
			if (autoCopy && shared.state.link) {
				try {
					if (typeof navigator === 'undefined' ||
						!navigator.clipboard ||
						typeof navigator.clipboard.writeText !== 'function') {
						throw new Error('Clipboard API unavailable');
					}
					await navigator.clipboard.writeText(shared.state.link);
					shared.setStatus(
						'Secret stored and the share link was copied to your clipboard automatically.' +
						passwordNote,
						true);
				} catch (copyErr) {
					console.error(copyErr);
					shared.setStatus(
						'Secret stored, but automatic link copy failed. Use the copy button above.' +
						passwordNote,
						true);
				}
			} else {
				shared.setStatus('Secret stored. Share the generated link.' +
					passwordNote,
					true);
			}
		} catch (err) {
			console.error(err);
			shared.setStatus(err.message || String(err));
		} finally {
			if (payload)
				payload.fill(0);
			if (taggedPayload)
				taggedPayload.fill(0);
			if (ciphertext)
				ciphertext.fill(0);
			if (blob)
				blob.fill(0);
			if (keyBytes)
				keyBytes.fill(0);
			if (nonce)
				nonce.fill(0);
			if (salt)
				salt.fill(0);
			if (idBytes)
				idBytes.fill(0);
			shared.lockTextarea(false);
		}
	}

	function init() {
		const btnGetLink = shared.$('btnGetLink');
		const btnCopyLink = shared.$('btnCopyLink');
		const optionalPasswordField = shared.$('optionalPassword');
		const textArea = shared.$('text');
		const qrButton = shared.$('btnGenerateQr');
		const hostInput = shared.$('host');

		if (!btnGetLink || !btnCopyLink || !optionalPasswordField ||
			!textArea || !qrButton || !hostInput) {
			return;
		}

		if (shared.state.originalPlaceholder === null) {
			const initial = textArea.getAttribute('placeholder');
			shared.state.originalPlaceholder =
				typeof initial === 'string' ? initial : '';
		}

		btnGetLink.addEventListener('click', () => { void sendSecret(false); });
		btnCopyLink.addEventListener('click', shared.copyLink);

		textArea.addEventListener('keydown', (event) => {
			const modifierPressed = shared.isMacLike ? event.metaKey : event.ctrlKey;
			if (event.key === 'Enter' && modifierPressed) {
				if (!event.repeat)
					void sendSecret(true);
				event.preventDefault();
			}
		});

		optionalPasswordField.addEventListener('keydown', (event) => {
			const modifierPressed = shared.isMacLike ? event.metaKey : event.ctrlKey;
			if (event.key === 'Enter' && modifierPressed) {
				if (!event.repeat)
					void sendSecret(true);
				event.preventDefault();
			}
		});

		qrButton.addEventListener('click', () => {
			if (!shared.state.link) {
				shared.setStatus('Generate a link first.');
				return;
			}
			shared.state.qrVisible = !shared.state.qrVisible;
			shared.updateQr();
			qrButton.textContent = shared.state.qrVisible ?
				'Hide QR' :
				'Generate QR';
			if (shared.state.qrVisible)
				shared.setStatus('QR code generated.', true);
		});

		hostInput.addEventListener('change', () => {
			if (!shared.state.id || !shared.state.bK)
				return;
			try {
				const origin = shared.getOrigin();
				shared.setLink(origin, shared.state.id, shared.state.bK);
			} catch {
				// keep previously generated link until origin is valid again
			}
		});
	}

	window.AdNihilumSend = { init };
})();
