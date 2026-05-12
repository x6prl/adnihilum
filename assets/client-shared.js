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
	const $ = (id) => document.getElementById(id);
	const encoder = new TextEncoder();
	const decoder = new TextDecoder('utf-8', { fatal: false });
	const HKDF_INFO_ID = encoder.encode('blob-id');
	const ID_REGEX = /^[A-Za-z0-9_-]{16,}$/;

	const KEY_SIZE = 32;
	const NONCE_SIZE = 12;
	const SALT_SIZE = 16;
	const ID_SIZE = 16;
	const BLOB_TYPE_SIZE = 2;
	const BLOB_TYPE_TEXT = new Uint8Array([0x13, 0x37]);
	const BLOB_TYPE_PASSWORD = new Uint8Array([0x73, 0x37]);
	const BLOB_TYPE_TEXT_VALUE = 0x1337;
	const BLOB_TYPE_PASSWORD_VALUE = 0x7337;
	const BLOB_SIZE_MAX = 128 * 1024;
	const PBKDF2_ITERATIONS = 800000;
	const PBKDF2_HASH = 'SHA-256';
	const HKDF_HASH = 'SHA-256';

	const QRCODE_SIZE = 220;
	const QRCODE_BORDER = 10;
	const QRCODE_CORRECT_LEVEL = 1;

	const state = {
		id: null,
		bK: null,
		link: null,
		pendingSecret: null,
		originalPlaceholder: null,
		originalReadonly: null,
	};
	let qrInstance = null;

	const isMacLike = (() => {
		if (typeof navigator === 'undefined')
			return false;
		const id = navigator.platform || navigator.userAgent || '';
		return /(Mac|iPhone|iPad|iPod)/i.test(id);
	})();

	function normalizeOrigin(origin) {
		return origin.replace(/\/+$/, '');
	}

	function clearLocationHash() {
		if (typeof window === 'undefined')
			return;
		try {
			if (typeof history !== 'undefined' &&
				typeof history.replaceState === 'function') {
				const path = window.location.pathname +
					window.location.search;
				history.replaceState(null, '', path);
			} else {
				window.location.hash = '';
			}
		} catch {
			window.location.hash = '';
		}
	}

	function initPopup() {
		const popup = $('appPopup');
		if (!popup || popup.dataset.bound === 'true')
			return;

		popup.dataset.bound = 'true';
		popup.addEventListener('click', (event) => {
			if (event.target === popup)
				popup.close();
		});
	}

	function showPopup(title, message) {
		const popup = $('appPopup');
		const titleEl = $('appPopupTitle');
		const bodyEl = $('appPopupBody');
		if (!popup || !titleEl || !bodyEl)
			return;

		titleEl.textContent = title || 'Action needed';
		bodyEl.textContent = message || '';
		if (typeof popup.showModal === 'function') {
			if (!popup.open)
				popup.showModal();
		} else {
			popup.setAttribute('open', 'open');
		}
	}

	function clearPendingSecret() {
		const pending = state.pendingSecret;
		if (!pending)
			return;
		if (pending.ciphertext)
			pending.ciphertext.fill(0);
		if (pending.nonce)
			pending.nonce.fill(0);
		if (pending.salt)
			pending.salt.fill(0);
		state.pendingSecret = null;
	}

	function setDecryptionCardVisible(visible) {
		const deCard = $('decryptionCard');
		if (deCard) {
			deCard.classList.toggle('is-visible', !!visible);
			const stack = deCard.closest('.stack');
			if (stack)
				stack.classList.toggle('stack-decryption-active',
					!!visible);
		}
		if (!visible) {
			const pwd = $('decryptionPassword');
			if (pwd)
				pwd.value = '';
		}
	}

	function scrubSensitiveUi() {
		['text', 'optionalPassword', 'decryptionPassword', 'generatedUrl']
			.forEach((id) => {
				const field = $(id);
				if (!field || typeof field.value !== 'string' ||
					!field.value)
					return;
				if (field.classList.contains('receive-state-info') ||
					field.classList.contains('receive-state-error')) {
					return;
				}
				field.value = '';
				field.dispatchEvent(
					new Event('input', { bubbles: true }));
			});
		setLink(null, null, null);
		setDecryptionCardVisible(false);
		clearPendingSecret();
	}

	function bindSensitiveUiScrubbing() {
		if (typeof window === 'undefined' || typeof document === 'undefined')
			return;
		if (document.documentElement.dataset.sensitiveUiBound === 'true')
			return;
		document.documentElement.dataset.sensitiveUiBound = 'true';

		const scrubSoon = () => {
			if (typeof window.requestAnimationFrame === 'function') {
				window.requestAnimationFrame(
					() => { scrubSensitiveUi(); });
			} else {
				setTimeout(scrubSensitiveUi, 0);
			}
		};

		scrubSoon();
		window.addEventListener('pagehide', scrubSensitiveUi);
		window.addEventListener('pageshow', (event) => {
			if (event.persisted)
				scrubSoon();
		});
	}

	function lockTextarea(lock) {
		const textField = $('text');
		if (!textField)
			return;

		if (state.originalPlaceholder === null) {
			const initial = textField.getAttribute('placeholder');
			state.originalPlaceholder =
				typeof initial === 'string' ? initial : '';
		}
		if (state.originalReadonly === null)
			state.originalReadonly = textField.hasAttribute('readonly');

		if (lock) {
			textField.classList.add('textarea-locked');
			textField.setAttribute('readonly', 'true');
		} else {
			textField.classList.remove('textarea-locked');
			if (state.originalReadonly)
				textField.setAttribute('readonly', 'true');
			else
				textField.removeAttribute('readonly');
			if (state.originalPlaceholder === '') {
				textField.removeAttribute('placeholder');
			} else {
				textField.setAttribute('placeholder',
					state.originalPlaceholder);
			}
		}

		textField.dispatchEvent(new Event('input', { bubbles: true }));
	}

	function cloneBytes(view) {
		if (!(view instanceof Uint8Array))
			return null;
		const copy = new Uint8Array(view.length);
		copy.set(view);
		return copy;
	}

	function bytesToHex(bytes) {
		let out = '';
		for (let i = 0; i < bytes.length; i++)
			out += bytes[i].toString(16).padStart(2, '0');
		return out;
	}

	function equal16B(a, b) {
		const wa = new Uint32Array(a.buffer, a.byteOffset, 4);
		const wb = new Uint32Array(b.buffer, b.byteOffset, 4);
		return !((wa[0] ^ wb[0]) | (wa[1] ^ wb[1]) | (wa[2] ^ wb[2]) |
			(wa[3] ^ wb[3]));
	}

	function updateQr() {
		const wrap = $('qrWrap');
		const container = $('qrCode');
		const copyQrBtn = $('btnCopyQrImage');
		if (!wrap || !container)
			return;

		if (!state.link) {
			wrap.hidden = true;
			if (copyQrBtn)
				copyQrBtn.hidden = true;
			if (qrInstance && typeof qrInstance.clear === 'function')
				qrInstance.clear();
			container.innerHTML = '';
			qrInstance = null;
			return;
		}

		try {
			if (typeof window.QRCode !== 'function')
				throw new Error('QR renderer unavailable');
			if (!qrInstance) {
				qrInstance = new QRCode(container, {
					width: QRCODE_SIZE,
					height: QRCODE_SIZE,
					border: QRCODE_BORDER,
					colorDark: '#000000',
					colorLight: '#ffffff',
					correctLevel: QRCODE_CORRECT_LEVEL === 0 ?
						QRCode.CorrectLevel.L :
						QRCode.CorrectLevel.H,
				});
			} else if (typeof qrInstance.clear === 'function') {
				qrInstance.clear();
			}
			qrInstance.makeCode(state.link);
			wrap.hidden = false;
			if (copyQrBtn)
				copyQrBtn.hidden = false;
		} catch (err) {
			console.error(err);
			wrap.hidden = true;
			if (copyQrBtn)
				copyQrBtn.hidden = true;
			if (qrInstance && typeof qrInstance.clear === 'function')
				qrInstance.clear();
			container.innerHTML = '';
			qrInstance = null;
		}
	}

	function getQrImageBlob() {
		const container = $('qrCode');
		if (!container)
			return Promise.reject(new Error('QR code is not available'));

		const canvas = container.querySelector('canvas');
		if (canvas) {
			return new Promise((resolve, reject) => {
				canvas.toBlob((blob) => {
					if (blob)
						resolve(blob);
					else
						reject(new Error(
							'Could not prepare QR image'));
				}, 'image/png');
			});
		}

		const img = container.querySelector('img');
		if (img && img.src && img.src.startsWith('data:')) {
			return fetch(img.src).then((response) => {
				if (!response.ok)
					throw new Error('Could not prepare QR image');
				return response.blob();
			});
		}

		const svg = container.querySelector('svg');
		if (svg) {
			return Promise.resolve(
				new Blob([new XMLSerializer().serializeToString(svg)],
					{ type: 'image/svg+xml' }));
		}

		return Promise.reject(new Error('QR code is not available'));
	}

	function setLink(origin, id, bK) {
		const wrap = $('generatedWrap');
		const input = $('generatedUrl');
		const copyBtn = $('btnCopyLink');
		const copyQrBtn = $('btnCopyQrImage');

		const reset = () => {
			state.id = null;
			state.bK = null;
			state.link = null;
			if (wrap)
				wrap.hidden = true;
			if (input)
				input.value = '';
			if (copyBtn)
				copyBtn.hidden = true;
			if (copyQrBtn)
				copyQrBtn.hidden = true;
		};

		if (!origin || !id || !bK) {
			reset();
			updateQr();
			return;
		}

		let keyBytes = null;
		let idBytes = null;
		try {
			const normalized = normalizeOrigin(origin);
			keyBytes = base64UrlDecode(bK);
			if (!keyBytes || keyBytes.length !== KEY_SIZE)
				throw new Error('Key length mismatch');
			idBytes = base64UrlDecode(id);
			if (!idBytes || idBytes.length !== ID_SIZE)
				throw new Error('ID length mismatch');

			const keyBase64Url = base64UrlEncode(keyBytes);
			const idBase64Url = base64UrlEncode(idBytes);
			state.link = normalized + '/receive#' + idBase64Url + '/' +
				keyBase64Url;
			state.id = idBase64Url;
			state.bK = keyBase64Url;

			if (wrap)
				wrap.hidden = false;
			if (input)
				input.value = state.link;
			if (copyBtn)
				copyBtn.hidden = false;
			if (copyQrBtn)
				copyQrBtn.hidden = false;
		} catch (err) {
			console.error(err);
			reset();
			updateQr();
			return;
		} finally {
			if (keyBytes)
				keyBytes.fill(0);
			if (idBytes)
				idBytes.fill(0);
		}

		updateQr();
	}

	function getOrigin() {
		const protocol = window.location.protocol || '';
		let raw = '';

		if (protocol === 'file:')
			raw = 'https://adnihilum.net';
		else if (window.location.origin &&
			window.location.origin !== 'null')
			raw = window.location.origin;

		let parsed;
		try {
			parsed = new URL(raw);
		} catch {
			throw new Error('Invalid service origin URL');
		}

		if (parsed.username || parsed.password)
			throw new Error('Origin must not include credentials');
		if ((parsed.pathname && parsed.pathname !== '/') || parsed.search ||
			parsed.hash) {
			throw new Error(
				'Origin must not include path, query, or fragment');
		}

		const isLocal = parsed.hostname === 'localhost' ||
			parsed.hostname === '127.0.0.1';
		if (parsed.protocol !== 'https:' && !isLocal)
			throw new Error('Service origin must use https://');

		return parsed.origin;
	}

	function base64UrlEncode(bytes) {
		if (!(bytes instanceof Uint8Array))
			throw new TypeError('Expected Uint8Array');
		let bin = '';
		for (let i = 0; i < bytes.length; i++)
			bin += String.fromCharCode(bytes[i]);
		return btoa(bin)
			.replace(/\+/g, '-')
			.replace(/\//g, '_')
			.replace(/=+$/g, '');
	}

	function base64UrlDecode(str) {
		try {
			const normalized = str.replace(/-/g, '+').replace(/_/g, '/');
			const pad = normalized.length % 4;
			const padded = normalized + (pad ? '===='.slice(pad) : '');
			const bin = atob(padded);
			const out = new Uint8Array(bin.length);
			for (let i = 0; i < bin.length; i++)
				out[i] = bin.charCodeAt(i);
			return out;
		} catch {
			throw new Error('Invalid base64 data');
		}
	}

	async function deriveIdFromKeyAndSalt(keyBytes, saltBytes) {
		const hkdfKey = await crypto.subtle.importKey('raw', keyBytes, 'HKDF',
			false, ['deriveBits']);
		const bytes = await crypto.subtle.deriveBits({
			name: 'HKDF',
			hash: HKDF_HASH,
			salt: saltBytes,
			info: HKDF_INFO_ID
		},
			hkdfKey, ID_SIZE * 8);
		return new Uint8Array(bytes);
	}

	async function derivePasswordKey(password, saltBytes, usages) {
		const passwordBytes = encoder.encode(password);
		let keyMaterial;
		try {
			keyMaterial = await crypto.subtle.importKey(
				'raw', passwordBytes, 'PBKDF2', false, ['deriveKey']);
		} finally {
			passwordBytes.fill(0);
		}
		return crypto.subtle.deriveKey(
			{
				name: 'PBKDF2',
				salt: saltBytes,
				iterations: PBKDF2_ITERATIONS,
				hash: PBKDF2_HASH,
			},
			keyMaterial, { name: 'AES-GCM', length: KEY_SIZE * 8 }, false,
			usages);
	}

	function parseLocationHash(input) {
		if (!input)
			return null;
		let raw = input.trim();
		try {
			const maybeUrl = new URL(raw);
			raw = maybeUrl.hash || '';
		} catch {
			// not a full URL
		}
		if (raw.startsWith('#'))
			raw = raw.slice(1);
		const hashIndex = raw.indexOf('#');
		if (hashIndex >= 0)
			raw = raw.slice(hashIndex + 1);
		raw = raw.replace(/^\/+/, '');

		const parts = raw.split('/');
		if (parts.length !== 2)
			return null;

		const idPart = parts[0].trim();
		const keyPart = parts[1].trim();
		if (!idPart || !keyPart || !ID_REGEX.test(idPart))
			return null;

		return { id: idPart, bK: keyPart };
	}

	async function copyLink() {
		if (!state.link)
			return;
		await navigator.clipboard.writeText(state.link);
	}

	async function copyQrImage() {
		if (!state.link)
			return;
		if (typeof navigator === 'undefined' || !navigator.clipboard ||
			typeof navigator.clipboard.write !== 'function' ||
			typeof ClipboardItem !== 'function') {
			throw new Error(
				'Image clipboard is not available in this browser');
		}

		const blob = await getQrImageBlob();
		await navigator.clipboard.write(
			[new ClipboardItem({ [blob.type]: blob })]);
	}

	async function safeText(res) {
		try {
			return await res.text();
		} catch {
			return '';
		}
	}

	function initCommonUi() {
		const createLinks = document.querySelectorAll('[data-create-link]');
		if (createLinks.length > 0) {
			let createHref = '/';
			try {
				createHref =
					new URL('/', window.location.href).toString();
			} catch {
				createHref = '/';
			}
			createLinks.forEach(
				(link) => { link.setAttribute('href', createHref); });
		}

		document.addEventListener('DOMContentLoaded', function () {
			const textarea = document.querySelector(
				'textarea[data-limit-indicator="true"]');
			if (textarea) {
				const indicator = document.createElement('div');
				const bar = document.createElement('div');
				const fill = document.createElement('span');
				const label = document.createElement('div');
				const byteEncoder = typeof TextEncoder === 'function' ?
					new TextEncoder() :
					null;
				const maxBytes = BLOB_SIZE_MAX - 100;

				indicator.classList.add('limit-indicator');
				indicator.hidden = true;
				bar.classList.add('limit-indicator-bar');
				fill.classList.add('limit-indicator-fill');
				label.classList.add('limit-indicator-label');
				bar.appendChild(fill);
				indicator.appendChild(bar);
				indicator.appendChild(label);
				textarea.parentNode.appendChild(indicator);

				const updateCount = () => {
					const value = textarea.value || '';
					const sizeBytes =
						byteEncoder ? byteEncoder.encode(value)
							.length :
							value.length;
					const usageRatio =
						maxBytes ? sizeBytes / maxBytes : 0;

					indicator.classList.remove('warning', 'danger');
					if (!value || usageRatio < 0.8) {
						indicator.hidden = true;
						fill.style.width = '0%';
						label.textContent = '';
						return;
					}

					indicator.hidden = false;
					fill.style.width =
						Math.max(
							8,
							Math.min(100,
								Math.round(usageRatio *
									100))) +
						'%';

					if (usageRatio >= 1) {
						indicator.classList.add('danger');
						label.textContent =
							'Too large. Shorten the secret and try again.';
					} else if (usageRatio > 0.9) {
						indicator.classList.add('danger');
						label.textContent =
							'Very close to the limit.';
					} else {
						indicator.classList.add('warning');
						label.textContent =
							'Approaching the size limit.';
					}
				};

				textarea.addEventListener('input', updateCount);
				updateCount();
			}
		});
	}

	window.AdNihilumShared = {
		$,
		encoder,
		decoder,
		KEY_SIZE,
		NONCE_SIZE,
		SALT_SIZE,
		ID_SIZE,
		BLOB_TYPE_SIZE,
		BLOB_TYPE_TEXT,
		BLOB_TYPE_PASSWORD,
		BLOB_TYPE_TEXT_VALUE,
		BLOB_TYPE_PASSWORD_VALUE,
		BLOB_SIZE_MAX,
		isMacLike,
		state,
		normalizeOrigin,
		clearLocationHash,
		clearPendingSecret,
		scrubSensitiveUi,
		setDecryptionCardVisible,
		lockTextarea,
		cloneBytes,
		bytesToHex,
		equal16B,
		updateQr,
		setLink,
		getOrigin,
		base64UrlEncode,
		base64UrlDecode,
		deriveIdFromKeyAndSalt,
		derivePasswordKey,
		parseLocationHash,
		copyLink,
		copyQrImage,
		safeText,
		initPopup,
		showPopup,
		initCommonUi,
		bindSensitiveUiScrubbing,
	};
})();
