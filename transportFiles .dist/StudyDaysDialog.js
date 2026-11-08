sap.ui.define([
	"sap/ui/base/Object",
	"sap/ui/core/Fragment",
	"sap/ui/model/json/JSONModel"
], function (BaseObject, Fragment, JSONModel) {
	"use strict";

	/* ============================================================================
	   פירוט ימי לימודים - the dialog's whole logic
	   ----------------------------------------------------------------------------
	   Self-contained on purpose: the screen that opens it creates one instance and
	   calls open(), and that is the entire contract.

	     new StudyDaysDialog(oView).open()

	   The fragment (view/StudyDays.fragment.xml) is loaded with this object as its
	   controller, added as a dependent of the opener's view - so the view destroys
	   it, and i18n reaches it by propagation - and given its own "sd" model.

	   Data: _fetch() is the one seam. It answers from MOCK_ROWS today; when the
	   backend entity exists, only its body changes - _toViewData() already takes
	   the raw shape (dates as Date, numbers as numbers) and does all formatting.
	   ========================================================================= */

	/** Day-of-week letters, Sunday first, as Date#getDay() counts. */
	var DAY_LETTERS = ["א", "ב", "ג", "ד", "ה", "ו", "ש"];

	var MOCK_ROWS = [
		{ description: "לימודי תואר שני במנהל עסקים", from: [2025, 1, 6], to: [2025, 1, 6], quota: 6, used: 5, absenceType: "בחינות תואר שני", note: "הערה הערה הערה" },
		{ description: "לימודי תואר שני במנהל עסקים", from: [2025, 1, 13], to: [2025, 1, 13], quota: 1, used: 1, absenceType: "בחינות תואר שני", note: "הערה הערה הערה" },
		{ description: "לימודי תואר שני במנהל עסקים", from: [2025, 1, 20], to: [2025, 1, 20], quota: 1, used: 1, absenceType: "בחינות תואר שני", note: "הערה הערה הערה" },
		{ description: "לימודי תואר שני במנהל עסקים", from: [2025, 1, 27], to: [2025, 1, 27], quota: 1, used: 1, absenceType: "בחינות תואר שני", note: "הערה הערה הערה" },
		{ description: "לימודי תואר שני במנהל עסקים", from: [2025, 1, 27], to: [2025, 1, 27], quota: 6, used: 3, absenceType: "בחינות תואר שני", note: "הערה הערה הערה" }
	];

	/* ---- module-level pure helpers ---------------------------------------- */

	function pad2(i) {
		return (i < 10 ? "0" : "") + i;
	}

	/** Date -> "01/01/2025" */
	function formatDate(oDate) {
		return oDate ? pad2(oDate.getDate()) + "/" + pad2(oDate.getMonth() + 1) + "/" + oDate.getFullYear() : "";
	}

	/** Date -> "2025-01-01", the DatePicker's valueFormat. */
	function toIsoDate(oDate) {
		return oDate.getFullYear() + "-" + pad2(oDate.getMonth() + 1) + "-" + pad2(oDate.getDate());
	}

	function dayLetter(oDate) {
		return oDate ? DAY_LETTERS[oDate.getDay()] : "";
	}

	/** Whole percent of used out of quota, clamped to 0..100. */
	function percentOf(nUsed, nQuota) {
		if (!nQuota) {
			return 0;
		}
		return Math.max(0, Math.min(100, Math.round((nUsed / nQuota) * 100)));
	}

	var StudyDaysDialog = BaseObject.extend("modtimesheet.controller.StudyDaysDialog", {

		constructor: function (oView) {
			BaseObject.call(this);
			this._oView = oView;
			this._oModel = new JSONModel({
				date: toIsoDate(new Date()),
				rows: [],
				total: {}
			});
		},

		/** Loads the fragment once, refreshes the data, then opens. */
		open: function () {
			var that = this;

			if (!this._pDialog) {
				this._pDialog = Fragment.load({
					id: this._oView.getId() + "--sd",
					name: "modtimesheet.view.StudyDays",
					controller: this
				}).then(function (oDialog) {
					that._oView.addDependent(oDialog);
					oDialog.setModel(that._oModel, "sd");
					return oDialog;
				});
			}

			return this._pDialog.then(function (oDialog) {
				// filled first, opened second - never shows the previous open's rows
				return that._load(oDialog).then(function () {
					oDialog.open();
				});
			});
		},

		/* ---- data ---------------------------------------------------------- */

		_load: function (oDialog) {
			var that = this;

			oDialog.setBusy(true);

			return this._fetch(this._oModel.getProperty("/date")).then(function (aRaw) {
				var oData = that._toViewData(aRaw);
				that._oModel.setProperty("/rows", oData.rows);
				that._oModel.setProperty("/total", oData.total);
			}).catch(function (oErr) {
				window.console && window.console.error("StudyDaysDialog: load failed", oErr);
				that._oModel.setProperty("/rows", []);
				that._oModel.setProperty("/total", that._toViewData([]).total);
			}).then(function () {
				oDialog.setBusy(false);
			});
		},

		/**
		 * The backend seam. sIsoDate is the date in the header field ("2025-01-01").
		 * Resolves to [{ description, from: Date, to: Date, quota, used,
		 * absenceType, note }].
		 */
		_fetch: function (/* sIsoDate */) {
			return Promise.resolve(MOCK_ROWS.map(function (o) {
				return {
					description: o.description,
					from: new Date(o.from[0], o.from[1] - 1, o.from[2]),
					to: new Date(o.to[0], o.to[1] - 1, o.to[2]),
					quota: o.quota,
					used: o.used,
					absenceType: o.absenceType,
					note: o.note
				};
			}));
		},

		/** Raw rows -> render-ready rows + the סה"כ לחודש footer. */
		_toViewData: function (aRaw) {
			var oBundle = this._oView.getModel("i18n").getResourceBundle();
			var nQuota = 0;
			var nUsed = 0;

			var aRows = (aRaw || []).map(function (o) {
				var iPercent = percentOf(o.used, o.quota);
				nQuota += o.quota || 0;
				nUsed += o.used || 0;
				return {
					description: o.description,
					fromText: formatDate(o.from),
					fromDay: dayLetter(o.from),
					toText: formatDate(o.to),
					toDay: dayLetter(o.to),
					quotaText: (o.quota || 0).toFixed(1),
					usedText: (o.used || 0).toFixed(1),
					percentText: iPercent + "%",
					percentWidth: iPercent + "%",
					absenceType: o.absenceType,
					note: o.note
				};
			});

			var iTotalPercent = percentOf(nUsed, nQuota);

			return {
				rows: aRows,
				total: {
					quotaText: nQuota.toFixed(1),
					usedText: nUsed.toFixed(1),
					percentWidth: iTotalPercent + "%",
					summaryHtml: oBundle.getText("sdSummary", [String(iTotalPercent), nQuota.toFixed(2)])
				}
			};
		},

		/* ---- fragment event handlers --------------------------------------- */

		onDateChange: function (oEvent) {
			if (oEvent.getParameter("valid") !== false) {
				this._pDialog.then(this._load.bind(this));
			}
		},

		onClose: function () {
			this._pDialog.then(function (oDialog) { oDialog.close(); });
		},

		/** אישור והמשך - nothing to submit yet; it acknowledges and closes. */
		onConfirm: function () {
			this.onClose();
		}
	});

	// test seams
	StudyDaysDialog.percentOf = percentOf;
	StudyDaysDialog.formatDate = formatDate;
	StudyDaysDialog.dayLetter = dayLetter;

	return StudyDaysDialog;
});
