sap.ui.define([], function () {
	"use strict";

	/**
	 * The semantic accents of דף הבית, keyed by the `tone` a card metric or a
	 * "סטטוס הדו"ח" cell carries in the model.
	 *
	 * Same caveat as stepColor below: sap.ui.core.Icon takes a literal colour, so
	 * these cannot be read from css/tokens.css. Keep the two in sync - the bar
	 * fills of the very same tones are painted from the tokens, in css/style.css
	 * §11, off a data-tone attribute.
	 */
	var TONE_COLORS = {
		brand: "#3e5de6",   // --mt-color-brand
		warning: "#d6b85e", // --mt-color-warning
		muted: "#7d85a8",   // --mt-color-text-muted
		error: "#ba5265",   // --mt-color-error-accent
		success: "#52ba65"  // --mt-color-success
	};

	var formatter = {

		/**
		 * Maps a single process-step state to the colour of its dot.
		 * done -> approved, current -> pending, open -> not started.
		 *
		 * Values mirror the design tokens in css/tokens.css
		 * (--mt-color-success / --mt-color-warning / --mt-color-grey-dot);
		 * sap.ui.core.Icon takes a literal colour, so they cannot be read
		 * from CSS custom properties here. Keep the two in sync.
		 */
		stepColor: function (sState) {
			switch (sState) {
				case "done":
					return "#52ba65"; // --mt-color-success  - approved stage
				case "current":
					return "#d6b85e"; // --mt-color-warning  - waiting stage
				default:
					return "#d7d7d7"; // --mt-color-grey-dot - not started
			}
		},

		/** "1/3" text under the process dots. */
		stepText: function (iStep, iTotal) {
			if (iTotal === undefined || iTotal === null) {
				return "";
			}
			return (iStep || 0) + "/" + iTotal;
		},

		/** Extra-months hint next to the month, e.g. "+1" (frame 57:3979). */
		extraMonthsText: function (iExtra) {
			return iExtra > 0 ? "+" + iExtra : "";
		},

		extraMonthsVisible: function (iExtra) {
			return iExtra > 0;
		},

		/* ========================================================================
		   נתוני כל העובדים (AllEmployees)
		   ===================================================================== */

		/**
		 * "(9)" - the count next to the group header label.
		 * Renders nothing for a missing count rather than "(undefined)".
		 */
		countInParentheses: function (iCount) {
			return (iCount === undefined || iCount === null) ? "" : "(" + iCount + ")";
		},

		/* ========================================================================
		   דף הבית (Home)
		   ===================================================================== */

		/** Semantic accent of a KPI cell / metric row. Unknown tones read as brand. */
		toneColor: function (sTone) {
			return TONE_COLORS[sTone] || TONE_COLORS.brand;
		}

		// The 9px marker in front of a message needs no formatter: the card shows no
		// read / unread state, so the dot is a bullet in one colour and css §11f
		// sets it.

		// שם מנהל ישיר needs no formatter: managerName is filled on every row,
		// including the top level, whose direct manager is the logged-in user.
		//
		// Neither does שם עובד: all names share one weight now, so there is no
		// isManager flag to carry into the DOM.
	};

	return formatter;
});
