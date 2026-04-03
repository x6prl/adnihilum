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
		qrVisible: false,
		pendingSecret: null,
		originalPlaceholder: null,
	};
	let qrInstance = null;
	const STATUS_ICON_PATHS = {
		success:
			'<path d="M5 13l4 4L19 7" stroke-linecap="round" stroke-linejoin="round"/>',
		error: '<path d="M12 7v7" stroke-linecap="round" stroke-linejoin="round"/>' +
			'<path d="M12 17h.01" stroke-linecap="round" stroke-linejoin="round"/>',
		info: '<path d="M12 8h.01" stroke-linecap="round" stroke-linejoin="round"/>' +
			'<path d="M11 12h1v4h1" stroke-linecap="round" stroke-linejoin="round"/>'
	};
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

	function setStatus(msg, ok = false) {
		const wrap = $('statusNotification');
		const message = $('statusMessage');
		const subtitle = $('heroSubtitle');
		const iconHolder = $('statusIcon');
		const iconSvg =
			iconHolder ? iconHolder.querySelector('.status-icon-graphic') :
				null;
		const progress = $('progressBar');

		if (!wrap || !message || !subtitle || !iconSvg || !progress)
			return;

		if (!msg) {
			message.textContent = '';
			wrap.classList.remove('is-visible', 'is-success', 'is-error');
			progress.style.width = '0%';
			iconSvg.innerHTML = '';
			subtitle.classList.remove('is-hidden');
			return;
		}

		message.textContent = msg;
		wrap.classList.add('is-visible');
		wrap.classList.toggle('is-success', !!ok);
		wrap.classList.toggle('is-error', !ok);
		subtitle.classList.add('is-hidden');

		const iconKey = ok ? 'success' : 'error';
		iconSvg.innerHTML = STATUS_ICON_PATHS[iconKey] ||
			STATUS_ICON_PATHS.info || '';

		progress.style.transition = 'none';
		progress.style.width = '0%';
		void progress.offsetWidth;
		progress.style.transition = '';
		progress.style.width = '100%';
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
		const enCard = $('encryptionCard');
		if (!deCard || !enCard)
			return;
		if (visible) {
			deCard.classList.add('is-visible');
			enCard.classList.remove('is-visible');
		} else {
			deCard.classList.remove('is-visible');
			enCard.classList.add('is-visible');
			const pwd = $('decryptionPassword');
			if (pwd)
				pwd.value = '';
		}
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
		if (lock) {
			textField.classList.add('textarea-locked');
			textField.setAttribute('readonly', 'true');
			textField.setAttribute(
				'placeholder',
				'Secret will appear here after you decrypt it.');
		} else {
			textField.classList.remove('textarea-locked');
			textField.removeAttribute('readonly');
			if (state.originalPlaceholder !== null) {
				if (state.originalPlaceholder === '') {
					textField.removeAttribute('placeholder');
				} else {
					textField.setAttribute(
						'placeholder',
						state.originalPlaceholder);
				}
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
		if (!wrap || !container)
			return;
		const qrTarget = state.link;
		if (!state.qrVisible || !qrTarget) {
			wrap.style.display = 'none';
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
					correctLevel: QRCODE_CORRECT_LEVEL == 0 ?
						QRCode.CorrectLevel.L :
						QRCode.CorrectLevel.H,
				});
			} else if (typeof qrInstance.clear === 'function') {
				qrInstance.clear();
			}
			qrInstance.makeCode(qrTarget);
			wrap.style.display = 'flex';
		} catch (err) {
			console.error(err);
			wrap.style.display = 'none';
			if (qrInstance && typeof qrInstance.clear === 'function')
				qrInstance.clear();
			container.innerHTML = '';
			qrInstance = null;
			state.qrVisible = false;
			const btn = $('btnGenerateQr');
			if (btn)
				btn.textContent = 'Generate QR';
			setStatus(err.message || String(err));
		}
	}

	function setLink(origin, id, bK) {
		const wrap = $('generatedWrap');
		const input = $('generatedUrl');
		const copyBtn = $('btnCopyLink');
		const qrBtn = $('btnGenerateQr');

		const reset = () => {
			state.id = null;
			state.bK = null;
			state.link = null;
			state.qrVisible = false;
			if (wrap)
				wrap.style.display = 'none';
			if (input)
				input.value = '';
			if (copyBtn)
				copyBtn.style.display = 'none';
			if (qrBtn) {
				qrBtn.style.display = 'none';
				qrBtn.textContent = 'Generate QR';
			}
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
			state.link =
				normalized + '/#' + idBase64Url + '/' + keyBase64Url;
			state.id = idBase64Url;
			state.bK = keyBase64Url;

			if (wrap)
				wrap.style.display = 'flex';
			if (input)
				input.value = state.link;
			if (copyBtn)
				copyBtn.style.display = 'inline-block';
			const host = $('host');
			if (host)
				host.value = normalized;
		} catch (err) {
			console.error(err);
			setStatus(err.message || String(err));
			reset();
			updateQr();
			return;
		} finally {
			if (keyBytes)
				keyBytes.fill(0);
			if (idBytes)
				idBytes.fill(0);
		}

		if (qrBtn) {
			qrBtn.style.display = state.link ? 'inline-block' : 'none';
			qrBtn.textContent = state.qrVisible ? 'Hide QR' : 'Generate QR';
		}
		updateQr();
	}

	function getOrigin() {
		const el = $('host');
		if (!el)
			throw new Error('Service origin input is missing');
		const raw = (el.value.length > 6 ? el.value :
			'https://local.tanuki-gecko.ts.net')
			.trim();
		if (!raw)
			throw new Error('Service origin is empty');
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
			parsed.hostname === '127.0.0.1' ||
			parsed.hostname === '::1';
		if (parsed.protocol !== 'https:' && !isLocal)
			throw new Error('Service origin must use https://');
		const origin = parsed.origin;
		if (el.value !== origin)
			el.value = origin;
		return origin;
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
			// not a URL; continue
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
		if (!idPart || !keyPart)
			return null;

		if (!ID_REGEX.test(idPart) || !keyPart)
			return null;
		return { id: idPart, bK: keyPart };
	}

	async function copyLink() {
		try {
			if (!state.link) {
				setStatus('No link available to copy.', false);
				return;
			}
			await navigator.clipboard.writeText(state.link);
			setStatus('Link copied to clipboard.', true);
			setTimeout(() => {
				if (state.link)
					setStatus('');
			}, 1200);
		} catch (e) {
			setStatus('Could not copy link: ' + (e.message || e), false);
		}
	}

	async function safeText(res) {
		try {
			return await res.text();
		} catch {
			return '';
		}
	}

	function initCommonUi() {
		const hostInput = $('host');
		if (hostInput) {
			try {
				const current = window.location.origin;
				if (current && current !== 'null')
					hostInput.value = current;
			} catch (_) {
				// Ignore environments without window.location.origin support.
			}
		}

		document.addEventListener('DOMContentLoaded', function () {
			const textarea = $('text');
			const navToggle = document.querySelector('.nav-toggle');
			const navLinks = document.querySelector('.nav-links');

			if (textarea) {
				const charCount = document.createElement('div');
				const byteEncoder = typeof TextEncoder === 'function' ?
					new TextEncoder() :
					null;
				const maxBytes = BLOB_SIZE_MAX - 100;
				const maxKiBLabel = (maxBytes / 1024).toFixed(2);
				const toKiB = (bytes) => (bytes / 1024).toFixed(2);

				charCount.classList.add('char-counter');
				textarea.parentNode.appendChild(charCount);

				const updateCount = () => {
					const value = textarea.value || '';
					const sizeBytes = byteEncoder ?
						byteEncoder.encode(value).length :
						value.length;
					const usageKiB = toKiB(sizeBytes);

					charCount.textContent =
						maxKiBLabel ?
							`${usageKiB} of ${maxKiBLabel} KiB` :
							`${usageKiB} KiB`;
					charCount.classList.remove('warning', 'danger');

					if (maxBytes) {
						const usageRatio = sizeBytes / maxBytes;
						if (usageRatio > 0.9) {
							charCount.classList.add('danger');
						} else if (usageRatio > 0.8) {
							charCount.classList.add('warning');
						}
					}
				};

				textarea.addEventListener('input', updateCount);
				updateCount();
			}

			if (navToggle && navLinks) {
				const closeNav = () => {
					if (!navLinks.classList.contains('is-open'))
						return;
					navLinks.classList.remove('is-open');
					navToggle.classList.remove('is-active');
				};

				navToggle.addEventListener('click', () => {
					const isOpen = navLinks.classList.toggle('is-open');
					navToggle.classList.toggle('is-active', isOpen);
				});

				navLinks.addEventListener('click', (event) => {
					if (event.target.classList.contains('nav-link'))
						closeNav();
				});

				document.addEventListener('click', (event) => {
					if (!navLinks.contains(event.target) &&
						!navToggle.contains(event.target)) {
						closeNav();
					}
				});

				window.addEventListener('resize', () => {
					if (window.innerWidth > 768) {
						navLinks.classList.remove('is-open');
						navToggle.classList.remove('is-active');
					}
				});
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
		setStatus,
		clearPendingSecret,
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
		safeText,
		initCommonUi,
	};
})();
