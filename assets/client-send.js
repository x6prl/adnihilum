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
	let suppressGeneratedStateReset = false;

	function setPrimaryButtonLabel(text, stateClass) {
		const button = shared.$('btnGetLink');
		const label = shared.$('btnGetLinkLabel');
		if (!button || !label)
			return;

		if (!button.dataset.defaultLabel)
			button.dataset.defaultLabel = label.textContent;

		button.classList.remove('is-busy', 'is-ready', 'is-success');
		if (stateClass)
			button.classList.add('is-' + stateClass);

		label.textContent = text ||
			button.dataset.defaultLabel ||
			'Create and copy link';
	}

	function resetPrimaryButton() {
		const button = shared.$('btnGetLink');
		setPrimaryButtonLabel(
			button ? button.dataset.defaultLabel : 'Create and copy link');
	}

	function clearGeneratedState() {
		if (suppressGeneratedStateReset)
			return;
		if (shared.state.link)
			shared.setLink(null, null, null);
		resetPrimaryButton();
	}

	function friendlySendError(err) {
		const message = err && err.message ? err.message : String(err || '');
		if (/^Invalid service origin URL$/i.test(message))
			return 'Enter a valid service URL, for example https://example.com.';
		if (/^Origin must not include credentials$/i.test(message))
			return 'Remove the username and password from the service URL.';
		if (/^Origin must not include path, query, or fragment$/i.test(message))
			return 'Use only the site origin. Do not include a path, query string, or #fragment.';
		if (/^Service origin must use https:\/\//i.test(message))
			return 'Use an https:// service URL unless you are working on localhost.';
		if (/^Key length mismatch$|^ID length mismatch$|^Invalid base64 data$/i.test(message))
			return 'The generated link data was invalid. Try creating the secret again.';
		if (/^Image clipboard is not available/i.test(message))
			return 'Your browser cannot copy images directly. Copy the image yourself.';
		if (/^Clipboard API unavailable$/i.test(message))
			return 'The secret was created, but this browser could not copy the link automatically. Select the generated link and copy it yourself.';
		if (/Failed to fetch|NetworkError|Load failed/i.test(message))
			return 'Could not reach the secret service. Check that the server is running and the address is correct.';
		if (/POST .* 40[034]\b/i.test(message))
			return 'The server refused to save this secret. Try again with a fresh page.';
		if (/POST .* 41[03]\b/i.test(message))
			return 'The server is not accepting this request right now. Try again in a moment.';
		if (/POST .* 42[39]\b/i.test(message))
			return 'The service is being rate-limited or blocked. Wait a bit and try again.';
		if (/POST .* 5\d\d\b/i.test(message))
			return 'The server failed while saving the secret. Try again in a moment.';
		return 'Could not create the secret link. Please try again.';
	}

	function showSendError(err) {
		shared.showPopup('Could not create link', friendlySendError(err));
	}

	function setInputsDisabled(disabled) {
		['btnGetLink', 'btnCopyLink', 'btnCopyQrImage', 'optionalPassword']
			.forEach((id) => {
				const el = shared.$(id);
				if (el)
					el.disabled = disabled;
			});
	}

	function shouldAutoScrollComposer() {
		if (typeof window === 'undefined' ||
			typeof window.matchMedia !== 'function') {
			return false;
		}
		return window.matchMedia('(max-width: 900px)').matches ||
			window.matchMedia('(pointer: coarse)').matches;
	}

	function scrollComposerToTop(target) {
		const SCROLL_DELAY = 30;
		if (!target || !shouldAutoScrollComposer())
			return;

		const composerPanel = target.closest('.composer-panel');
		const scrollTarget = composerPanel || target;
		const doScroll = () => {
			scrollTarget.scrollIntoView({
				block: 'start',
				inline: 'nearest',
				behavior: 'smooth',
			});
		};

		doScroll();
		if (typeof window.requestAnimationFrame === 'function')
			window.requestAnimationFrame(doScroll);
		setTimeout(doScroll, SCROLL_DELAY);
	}

	function bindComposerFieldAutoScroll(field) {
		const FIELD_SELECTED_SCROLL_DELAY = 40;
		let viewprotTimer = null;
		const triggerScroll = () => {
			scrollComposerToTop(field);
		}
		const handleViewportChange = () => {
			if (viewprotTimer != null)
				clearTimeout(viewprotTimer);
			viewprotTimer = setTimeout(() => {
				viewprotTimer = null;
				if (document.activeElement === field)
					triggerScroll();
			}, FIELD_SELECTED_SCROLL_DELAY);
		}

		field.addEventListener('focus', triggerScroll);
		field.addEventListener('click', triggerScroll);

		if (window.visualViewport && typeof window.visualViewport.addEventListener === 'function') {
			field.addEventListener('focus', () => {
				window.visualViewport.addEventListener('resize', handleViewportChange);
			});
			field.addEventListener('blur', () => {
				window.visualViewport.removeEventListener('resize', handleViewportChange);
				if (viewprotTimer != null) {
					clearTimeout(viewprotTimer);
					viewprotTimer = null;
				}
			})
		}
	}

	async function sendSecret() {
		shared.clearPendingSecret();
		shared.lockTextarea(true);
		setInputsDisabled(true);
		setPrimaryButtonLabel('Creating link…', 'busy');

		let keyBytes = null;
		let nonce = null;
		let salt = null;
		let idBytes = null;
		let payload = null;
		let taggedPayload = null;
		let ciphertext = null;
		let blob = null;

		try {
			const origin = shared.getOrigin();
			const textField = shared.$('text');
			const passwordInput = shared.$('optionalPassword');
			if (!textField || !passwordInput)
				return;

			if (!textField.value) {
				resetPrimaryButton();
				textField.focus();
				shared.showPopup('Nothing to send',
					'Enter a secret before creating a link.');
				return;
			}

			const passwordValue = passwordInput.value;
			const hasPassword = typeof passwordValue === 'string' &&
				passwordValue.length > 0;
			payload = shared.encoder.encode(textField.value);
			keyBytes = crypto.getRandomValues(new Uint8Array(shared.KEY_SIZE));
			nonce = crypto.getRandomValues(new Uint8Array(shared.NONCE_SIZE));
			salt = crypto.getRandomValues(new Uint8Array(shared.SALT_SIZE));
			idBytes = await shared.deriveIdFromKeyAndSalt(keyBytes, salt);
			const idBase64Url = shared.base64UrlEncode(idBytes);
			const aad = shared.encoder.encode('id=' + idBase64Url);

			if (hasPassword) {
				const passwordKey = await shared.derivePasswordKey(
					passwordValue, salt, ['encrypt']);
				const wrappedBuffer = await crypto.subtle.encrypt(
					{ name: 'AES-GCM', iv: nonce, additionalData: aad },
					passwordKey,
					payload);
				payload.fill(0);
				payload = new Uint8Array(wrappedBuffer);
			}

			const tagBytes = hasPassword ?
				shared.BLOB_TYPE_PASSWORD :
				shared.BLOB_TYPE_TEXT;
			taggedPayload = new Uint8Array(shared.BLOB_TYPE_SIZE +
				payload.length);
			taggedPayload.set(tagBytes, 0);
			taggedPayload.set(payload, shared.BLOB_TYPE_SIZE);

			const aesKey = await crypto.subtle.importKey(
				'raw',
				keyBytes,
				{ name: 'AES-GCM', length: shared.KEY_SIZE * 8 },
				false,
				['encrypt']);
			ciphertext = new Uint8Array(await crypto.subtle.encrypt(
				{ name: 'AES-GCM', iv: nonce, additionalData: aad },
				aesKey,
				taggedPayload));

			taggedPayload.fill(0);
			taggedPayload = null;
			payload.fill(0);
			payload = null;

			blob = new Uint8Array(nonce.length + salt.length + ciphertext.length);
			blob.set(nonce, 0);
			blob.set(salt, nonce.length);
			blob.set(ciphertext, nonce.length + salt.length);
			if (blob.length > shared.BLOB_SIZE_MAX - 100) {
				resetPrimaryButton();
				shared.showPopup('Secret is too large',
					'Shorten the secret and try again.');
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
				const responseText = await shared.safeText(res);
				throw new Error(`POST ${url} ${res.status}: ${responseText || res.statusText}`);
			}

			passwordInput.value = '';
			shared.setLink(origin, shared.base64UrlEncode(idBytes),
				shared.base64UrlEncode(keyBytes));

			try {
				if (typeof navigator === 'undefined' ||
					!navigator.clipboard ||
					typeof navigator.clipboard.writeText !== 'function') {
					throw new Error('Clipboard API unavailable');
				}
				await navigator.clipboard.writeText(shared.state.link);
				setPrimaryButtonLabel('Success! Create another?', 'success');
			} catch (copyErr) {
				console.error(copyErr);
				setPrimaryButtonLabel('Link ready', 'ready');
				shared.showPopup('Link created',
					friendlySendError(copyErr));
			}
		} catch (err) {
			console.error(err);
			resetPrimaryButton();
			showSendError(err);
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
			suppressGeneratedStateReset = true;
			shared.lockTextarea(false);
			suppressGeneratedStateReset = false;
			setInputsDisabled(false);

			const copyBtn = shared.$('btnCopyLink');
			const qrBtn = shared.$('btnCopyQrImage');
			if (copyBtn)
				copyBtn.disabled = false;
			if (qrBtn)
				qrBtn.disabled = false;
		}
	}

	function init() {
		const btnGetLink = shared.$('btnGetLink');
		const btnCopyLink = shared.$('btnCopyLink');
		const btnCopyQrImage = shared.$('btnCopyQrImage');
		const optionalPasswordField = shared.$('optionalPassword');
		const textArea = shared.$('text');

		if (!btnGetLink || !btnCopyLink || !btnCopyQrImage ||
			!optionalPasswordField || !textArea) {
			return;
		}

		if (shared.state.originalPlaceholder === null) {
			const initial = textArea.getAttribute('placeholder');
			shared.state.originalPlaceholder =
				typeof initial === 'string' ? initial : '';
		}

		btnGetLink.addEventListener('click', () => { void sendSecret(); });
		btnCopyLink.addEventListener('click', shared.copyLink);
		btnCopyQrImage.addEventListener('click', () => {
			void shared.copyQrImage();
		});

		textArea.addEventListener('keydown', (event) => {
			const modifierPressed = shared.isMacLike ? event.metaKey : event.ctrlKey;
			if (event.key === 'Enter' && modifierPressed) {
				if (!event.repeat)
					void sendSecret();
				event.preventDefault();
			}
		});

		optionalPasswordField.addEventListener('keydown', (event) => {
			const modifierPressed = shared.isMacLike ? event.metaKey : event.ctrlKey;
			if (event.key === 'Enter' && modifierPressed) {
				if (!event.repeat)
					void sendSecret();
				event.preventDefault();
			}
		});

		textArea.addEventListener('input', clearGeneratedState);
		optionalPasswordField.addEventListener('input', clearGeneratedState);
		bindComposerFieldAutoScroll(textArea);
		bindComposerFieldAutoScroll(optionalPasswordField);

		resetPrimaryButton();
	}

	window.AdNihilumSend = { init };
})();
