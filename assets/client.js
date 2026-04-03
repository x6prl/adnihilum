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
	if (!shared)
		throw new Error('client-shared.js must be loaded before client.js');

	function initResponsivePlaceholders() {
		const text = document.getElementById('text');
		if (!text || typeof window.matchMedia !== 'function')
			return;

		const mobileMedia = window.matchMedia('(max-width: 680px)');
		const updatePlaceholders = function () {
			text.placeholder = mobileMedia.matches
				? text.dataset.placeholderMobile
				: text.dataset.placeholderDesktop;
		};

		updatePlaceholders();
		if (typeof mobileMedia.addEventListener === 'function')
			mobileMedia.addEventListener('change', updatePlaceholders);
		else if (typeof mobileMedia.addListener === 'function')
			mobileMedia.addListener(updatePlaceholders);
	}

	shared.initCommonUi();
	shared.initPopup();
	shared.bindSensitiveUiScrubbing();
	initResponsivePlaceholders();

	if (window.AdNihilumSend && typeof window.AdNihilumSend.init === 'function')
		window.AdNihilumSend.init();
	if (window.AdNihilumReceive &&
		typeof window.AdNihilumReceive.init === 'function') {
		window.AdNihilumReceive.init();
	}
})();
