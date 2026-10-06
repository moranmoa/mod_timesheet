sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/core/Fragment",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageToast",
	"sap/base/Log",
	"modtimesheet/model/formatter",
	"modtimesheet/model/DataService"
], function (Controller, Fragment, JSONModel, MessageToast, Log, formatter, DataService) {
	"use strict";

	/* ============================================================================
	   דף הבית - Home
	   ----------------------------------------------------------------------------
	   Data flow, in one place:

	     DataService.getHomeData({year, month, populationKey})
	       -> _toViewData(...)      counts -> bar widths, minutes -> "עודכן מלפני",
	                                name  -> greeting, type -> "הודעה כללית"
	       -> the "home" JSON model, which the view binds as-is.

	   Everything the view shows is therefore ready to render: no formatter reaches
	   the resource bundle, and the only one that remains (toneColor) exists because
	   sap.ui.core.Icon takes a literal colour.

	   The month stepper and the אוכלוסיה filter are request parameters, not
	   client-side filters - changing either re-asks the service, exactly as a real
	   backend needs.
	   ========================================================================= */

	/** How far back the month list offers to go (frame: "ינואר 2025"). */
	var MONTH_OPTION_COUNT = 24;

	/* ============================================================================
	   Module-level pure helpers
	   ----------------------------------------------------------------------------
	   Outside the controller object so they cannot reach `this`, same as on
	   AllEmployees.
	   ========================================================================= */

	/**
	 * A metric's share of its own card, as a CSS width for the bar's fill.
	 *
	 * Share-of-card rather than share-of-some-total: the reading the design asks
	 * for is "how much of this population's open work sits at this stage", and that
	 * is the only denominator the card itself carries.
	 *
	 * The 1% floor is deliberate. On the 310px track that is a 3px sliver, and it
	 * keeps a small count visible: "2" beside a completely empty bar reads as "0",
	 * which is the one thing the bar must not say. Only a real zero returns "0".
	 */
	function percentOfCard(iCount, iCardTotal) {
		if (!iCount) {
			return "0";
		}
		if (!iCardTotal) {
			return "100%";
		}
		return Math.max(1, Math.round((iCount / iCardTotal) * 100)) + "%";
	}

	function sumCounts(aMetrics) {
		return (aMetrics || []).reduce(function (iSum, oMetric) {
			return iSum + (oMetric.count || 0);
		}, 0);
	}

	/** Zero-based month index of a 1..12 month key, guarded. */
	function toMonthIndex(iMonth) {
		return Math.min(12, Math.max(1, iMonth || 1)) - 1;
	}

	return Controller.extend("modtimesheet.controller.Home", {

		formatter: formatter,

		/* ========================================================================
		   Lifecycle
		   ===================================================================== */

		onInit: function () {
			this._oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();
			this._aMonthNames = DataService.getFilterOptions().months;

			// The requested slice of data. The service owns everything else.
			//
			// The screen opens on the ACTIVE month and not on the calendar one: up
			// to the 10th the month that just ended is still being closed, so that
			// is the one people are working on. The rule lives in the DataService,
			// beside the call that asks the backend for the same span.
			var oPeriod = DataService.getActivePeriod();
			this._oRequest = {
				year: oPeriod.year,
				month: oPeriod.month,
				populationKey: "ALL"
			};

			// Bound before the first response so the view has something to render:
			// showSubordinates false keeps the second block out until the service
			// says the user may see it, rather than flashing it and taking it away.
			this.getView().setModel(new JSONModel({
				user: { greeting: "" },
				showSubordinates: false,
				reportStatus: [],
				messages: [],
				subordinateCards: [],
				populationOptions: [],
				populationKey: this._oRequest.populationKey,
				monthLabel: this._formatMonthLabel(this._oRequest.year, this._oRequest.month),
				monthOptions: this._buildMonthOptions()
			}), "home");

			this._load();
		},

		// No onExit: the month popover is added as a dependent of the view, so the
		// view destroys it. Destroying it here as well would be a double free.

		/* ========================================================================
		   Loading
		   ===================================================================== */

		_load: function () {
			var that = this;
			var oPage = this.byId("homePage");

			oPage.setBusy(true);

			return DataService.getHomeData(this.getOwnerComponent(), {
				year: this._oRequest.year,
				month: this._oRequest.month,
				populationKey: this._oRequest.populationKey
			}).then(function (oRaw) {
				that._applyHomeData(oRaw);
			}).catch(function (oError) {
				Log.error("Home: loading דף הבית failed", oError);
				MessageToast.show(that._oBundle.getText("hmErrorLoading"));
			}).then(function () {
				oPage.setBusy(false);
			});
		},

		/**
		 * Writes one service response into the model, leaving the parts the service
		 * does not own (the month label, the month list, the selected population)
		 * untouched - they are the request, not the response.
		 */
		_applyHomeData: function (oRaw) {
			var oModel = this.getView().getModel("home");
			var oData = this._toViewData(oRaw);

			Object.keys(oData).forEach(function (sKey) {
				oModel.setProperty("/" + sKey, oData[sKey]);
			});
		},

		/** Service shape -> render-ready shape. Pure apart from the bundle. */
		_toViewData: function (oRaw) {
			var that = this;
			var o = oRaw || {};

			return {
				user: {
					displayName: (o.user && o.user.displayName) || "",
					greeting: this._oBundle.getText("hmGreeting", [(o.user && o.user.displayName) || ""])
				},
				showSubordinates: !!o.showSubordinates,
				reportStatus: o.reportStatus || [],
				populationOptions: o.populationOptions || [],
				messages: (o.messages || []).map(function (oMessage) {
					return {
						// The kind of message, not its read state: הודעה כללית today,
						// הודעה אישית once phase ב' starts sending those too. An
						// unknown type falls back on כללית, which is the only kind the
						// service sends at the moment.
						typeText: that._oBundle.getText(
							oMessage.type === "PERSONAL" ? "hmMessagePersonal" : "hmMessageGeneral"
						),
						subject: oMessage.subject,
						body: oMessage.body
					};
				}),
				subordinateCards: (o.subordinateCards || []).map(function (oCard) {
					var iCardTotal = sumCounts(oCard.metrics);
					return {
						key: oCard.key,
						title: oCard.title,
						total: iCardTotal,
						updatedText: that._formatUpdatedText(oCard.updatedMinutesAgo),
						metrics: (oCard.metrics || []).map(function (oMetric) {
							return {
								label: oMetric.label,
								count: oMetric.count,
								tone: oMetric.tone,
								percent: percentOfCard(oMetric.count, iCardTotal)
							};
						})
					};
				})
			};
		},

		/* ========================================================================
		   Month stepper
		   ===================================================================== */

		/** "ינואר 2025" - the month names come from the same list as the filters. */
		_formatMonthLabel: function (iYear, iMonth) {
			var oMonth = this._aMonthNames[toMonthIndex(iMonth)];
			return (oMonth ? oMonth.text : String(iMonth)) + " " + iYear;
		},

		_formatUpdatedText: function (iMinutes) {
			return iMinutes > 0
				? this._oBundle.getText("hmUpdatedMinutes", [iMinutes])
				: this._oBundle.getText("hmUpdatedNow");
		},

		/** The last two years of months, newest first. */
		_buildMonthOptions: function () {
			var aOptions = [];
			var iYear = this._oRequest.year;
			var iMonth = this._oRequest.month;

			for (var i = 0; i < MONTH_OPTION_COUNT; i++) {
				aOptions.push({
					key: iYear + "-" + iMonth,
					year: iYear,
					month: iMonth,
					text: this._formatMonthLabel(iYear, iMonth),
					selected: i === 0
				});
				iMonth -= 1;
				if (iMonth === 0) {
					iMonth = 12;
					iYear -= 1;
				}
			}
			return aOptions;
		},

		/**
		 * Moves the request by whole months and re-asks the service.
		 * The month list is not rebuilt - it is a fixed window ending at today -
		 * only its selection follows.
		 */
		_stepMonth: function (iDelta) {
			var iMonth = this._oRequest.month + iDelta;
			var iYear = this._oRequest.year;

			while (iMonth > 12) { iMonth -= 12; iYear += 1; }
			while (iMonth < 1) { iMonth += 12; iYear -= 1; }

			this._setMonth(iYear, iMonth);
		},

		_setMonth: function (iYear, iMonth) {
			this._oRequest.year = iYear;
			this._oRequest.month = iMonth;

			var oModel = this.getView().getModel("home");
			var sKey = iYear + "-" + iMonth;

			oModel.setProperty("/monthLabel", this._formatMonthLabel(iYear, iMonth));
			oModel.getProperty("/monthOptions").forEach(function (oOption) {
				oOption.selected = oOption.key === sKey;
			});
			oModel.refresh(true);

			this._load();
		},

		onPreviousMonth: function () {
			this._stepMonth(-1);
		},

		onNextMonth: function () {
			this._stepMonth(1);
		},

		onOpenMonthPicker: function (oEvent) {
			var oOpener = oEvent.getSource();

			if (!this._pMonthPopover) {
				this._pMonthPopover = Fragment.load({
					id: this.getView().getId(),
					name: "modtimesheet.view.HomeMonthPicker",
					controller: this
				}).then(function (oPopover) {
					this.getView().addDependent(oPopover);
					return oPopover;
				}.bind(this));
			}

			this._pMonthPopover.then(function (oPopover) {
				oPopover.openBy(oOpener);
			});
		},

		onSelectMonth: function (oEvent) {
			var oContext = oEvent.getParameter("listItem").getBindingContext("home");
			var oOption = oContext.getObject();

			this._setMonth(oOption.year, oOption.month);

			this._pMonthPopover.then(function (oPopover) {
				oPopover.close();
			});
		},

		/* ========================================================================
		   Filters + actions
		   ===================================================================== */

		onPopulationChange: function (oEvent) {
			this._oRequest.populationKey = oEvent.getSource().getSelectedKey();
			this._load();
		},

		/**
		 * רענון הנתונים - go back to the service, rather than redraw what is
		 * already here.
		 *
		 * Dropping the cached context is the whole of it: the counters on this
		 * screen AND the filter option lists on the two report screens are counted
		 * off it, so this one press is what makes all three current. It is also the
		 * only thing that does - working the filters never disturbs those lists.
		 */
		onRefresh: function () {
			DataService.invalidateManagerContext();
			this._load();
		},

		/**
		 * A card title opens דוחות נוכחות באחריות ממונה, FOR THAT CARD.
		 *
		 * The card key travels in the hash (…#/ManagerReports?card=DIVISION) and
		 * the target screen turns it into the service's ImManagerType - TMGR for
		 * כפיפים, TADM for עובדי האגף, TMSA for אמ"ש, TSLD for חיילות. It is a
		 * query parameter and not a path segment because the screen is also
		 * reachable on its own, without a card, and then defaults to מנהל ישיר.
		 */
		onOpenCardReports: function (oEvent) {
			var oCard = oEvent.getSource().getBindingContext("home").getObject();

			this.getOwnerComponent().getRouter().navTo("managerReports", {
				"?query": { card: oCard.key }
			});
		},

		onOpenAllEmployees: function () {
			this.getOwnerComponent().getRouter().navTo("allEmployees");
		},

		/** No הזנת נוכחות screen exists in this app yet. */
		onEnterAttendance: function () {
			MessageToast.show(this._oBundle.getText("hmEnterAttendancePlaceholder"));
		},

		onPrint: function () {
			window.print();
		},

		/* ========================================================================
		   View-only formatting that needs the bundle
		   ===================================================================== */

		formatOpenReportsTooltip: function (sTitle) {
			return sTitle ? this._oBundle.getText("hmOpenCardReports", [sTitle]) : "";
		},

		/* ========================================================================
		   Test seams - thin wrappers over the module helpers above
		   ===================================================================== */

		percentOfCard: percentOfCard,
		sumCounts: sumCounts
	});
});
