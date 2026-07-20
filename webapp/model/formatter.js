sap.ui.define([], function () {
	"use strict";

	var formatter = {

		/**
		 * Maps a single process-step state to the colour of its dot.
		 * done -> green, current -> amber (waiting), open -> grey.
		 */
		stepColor: function (sState) {
			switch (sState) {
				case "done":
					return "#36a41d"; // green - approved stage
				case "current":
					return "#e9730c"; // amber - waiting stage
				default:
					return "#c6cdd5"; // grey - not started
			}
		},

		/** "1/3" text under the process dots. */
		stepText: function (iStep, iTotal) {
			if (iTotal === undefined || iTotal === null) {
				return "";
			}
			return (iStep || 0) + "/" + iTotal;
		},

		/** Shows the "N+" badge next to the month when there are extra months. */
		extraMonthsText: function (iExtra) {
			return iExtra > 0 ? iExtra + "+" : "";
		},

		extraMonthsVisible: function (iExtra) {
			return iExtra > 0;
		}
	};

	return formatter;
});
