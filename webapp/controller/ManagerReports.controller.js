sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/core/Fragment",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/ui/model/Sorter",
	"sap/m/ViewSettingsDialog",
	"sap/m/ViewSettingsItem",
	"sap/m/MessageToast",
	"sap/m/MessageBox",
	"sap/m/Token",
	"modtimesheet/model/DataService",
	"modtimesheet/model/formatter"
], function (Controller, Fragment, JSONModel, Filter, FilterOperator, Sorter,
	ViewSettingsDialog, ViewSettingsItem, MessageToast, MessageBox, Token, DataService, formatter) {
	"use strict";

	// i18n keys of the labels the table title names, keyed by status. The texts
	// themselves are mrStatus* in the bundle - they are fragments of the
	// mrTitlePending sentence, not labels in their own right.
	var STATUS_LABEL_KEY = {
		PENDING_EMPLOYEE: "mrStatusPendingEmployee",
		PENDING_MY_APPROVAL: "mrStatusPendingManager",
		PENDING_HR: "mrStatusPendingHr",
		APPROVED: "mrStatusApproved"
	};

	/**
	 * What counts as an address when the sender types one into "אל".
	 *
	 * Shape only - something@something.something with no spaces. Whether the
	 * mailbox exists is the mail server's answer, not this screen's; the check is
	 * here to catch the typo that would otherwise be sent silently.
	 */
	var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

	// The "הכל" pseudo-key, shared by the status tab bar and the
	// "נמצא בטיפול" drop-down. On both it means "no restriction".
	var ALL = "ALL";

	/**
	 * The status tabs and the "נמצא בטיפול" field describe the same thing -
	 * which party the report is waiting on - so the two are kept in sync
	 * (both directions). This is the mapping between them; the statuses that
	 * are absent (ALL, APPROVED) have no single handling party and map to
	 * "כל הגורמים המאשרים".
	 */
	var TAB_TO_PARTY = {
		PENDING_EMPLOYEE: "EMPLOYEE",
		PENDING_MY_APPROVAL: "MANAGER",
		PENDING_HR: "HR"
	};

	var PARTY_TO_TAB = Object.keys(TAB_TO_PARTY).reduce(function (o, sTab) {
		o[TAB_TO_PARTY[sTab]] = sTab;
		return o;
	}, {});

	/**
	 * The filters whose option lists describe the DATA and not a fixed domain.
	 *
	 * These four are filled from the SHARED manager context - the single
	 * /ManagerEmployeesSet read the app makes on entry - and not from the rows of
	 * the table below. That is deliberate and it is the point of the whole
	 * arrangement: the lists are already in memory, so opening one of these
	 * drop-downs is instant, and working the filter bar cannot reshuffle the very
	 * lists the user is picking from. They are rebuilt on a refresh and at no
	 * other time.
	 */
	var DATA_DRIVEN_FILTERS = [
		{ optionsKey: "populations", controlId: "populationFilter" },
		{ optionsKey: "branches", controlId: "branchFilter" },
		{ optionsKey: "units", controlId: "unitFilter" },
		{ optionsKey: "managers", controlId: "managerFilter" }
	];

	/**
	 * The period the service is asked for, derived from the שנה / חודש filters.
	 *
	 * Both are multi-selects and ImBeginDate / ImEndDate are a single span, so the
	 * span is the outer bounds of the selection: earliest selected month to the
	 * last day of the latest one. Nothing selected means the whole of the selected
	 * year(s), which is what an empty "הכל" filter says on screen.
	 *
	 * Both bounds are UTC midnights, because the model formats an Edm.DateTime
	 * filter value off a Date's UTC components - a local midnight would reach the
	 * backend as the previous day. See _normaliseReportParams in DataService.
	 *
	 * @param {string[]} aYearKeys  selected years, e.g. ["2025"]
	 * @param {string[]} aMonthKeys selected months, e.g. ["8"]
	 * @returns {{begin: Date, end: Date}} the requested span
	 */
	function buildPeriod(aYearKeys, aMonthKeys) {
		var oNow = new Date();
		var aYears = (aYearKeys && aYearKeys.length ? aYearKeys : [String(oNow.getFullYear())])
			.map(Number).sort(function (a, b) { return a - b; });
		var aMonths = (aMonthKeys && aMonthKeys.length ? aMonthKeys : ["1", "12"])
			.map(Number).sort(function (a, b) { return a - b; });

		return {
			begin: new Date(Date.UTC(aYears[0], aMonths[0] - 1, 1)),
			// day 0 of the next month is the last day of this one
			end: new Date(Date.UTC(aYears[aYears.length - 1], aMonths[aMonths.length - 1], 0))
		};
	}

	/**
	 * The year "ממתינים לאישור מחודשים קודמים" opens on.
	 *
	 * This one - except in January, where every month that has already passed
	 * belongs to last year: a January screen asking for earlier months has
	 * nothing to show inside its own year, so the toggle steps one year back
	 * rather than open on a year that cannot hold what it is asking for.
	 *
	 * @param {Date} [oNow] the moment to derive it from (default: now)
	 * @returns {number} the year to preselect in שנה
	 */
	function oldReportsYear(oNow) {
		var oDate = oNow || new Date();
		return oDate.getMonth() === 0 ? oDate.getFullYear() - 1 : oDate.getFullYear();
	}

	return Controller.extend("modtimesheet.controller.ManagerReports", {

		formatter: formatter,

		/* =============================== lifecycle =============================== */

		onInit: function () {
			this._oCurrentUser = DataService.getCurrentUser();

			// ImManagerType + the "כפיפים" depth, until the route says otherwise
			// (see _onRouteMatched) - both are decided by the card, not by the user
			this._sManagerType = DataService.getManagerType("");
			this._sSubordinateScope = DataService.getSubordinateScope("");

			// The screen's defaults follow the CARD and not the user: someone who
			// is both מנהל and אמ"ש holds two roles at once, and which of them
			// this screen is showing is decided by the card they pressed. See
			// ROLE_PRECEDENCE in the DataService for the other side of this.
			this._oRoleDefaults = DataService.getRoleDefaults(this._sManagerType);
			// mock until a load says otherwise - it decides whether the mock-only
			// filter defaults (שם מנהל ישיר = M1) may be applied at all
			this._bMockData = true;

			// filter drop-down options
			this.getView().setModel(new JSONModel(DataService.getFilterOptions()), "options");

			// view state (counts, title, advanced-filters toggle)
			this.getView().setModel(new JSONModel({
				statusCounts: {
					ALL: 0,
					PENDING_EMPLOYEE: 0,
					PENDING_MY_APPROVAL: 0,
					PENDING_HR: 0,
					APPROVED: 0
				},
				tableTitle: "",
				filtersExpanded: false,
				// ממתינים לאישור מחודשים קודמים - off by default: the common
				// case is the month the user is in, not what it left behind
				oldReports: false,
				// שליחת תזכורת - refilled from the service on every open of the
				// dialog, so what is here between opens is never read
				reminder: { subject: "", body: "" }
			}), "view");

			// data model (filled by the DataService)
			this._oReportsModel = new JSONModel({ items: [] });
			this.getView().setModel(this._oReportsModel, "reports");

			// initial default filters: current year + current month, everything else "all"
			this._setDefaultFilters();

			// The screen is opened from a דף הבית card, and the card decides which
			// population the service is asked for - so the load waits for the route.
			this.getOwnerComponent().getRouter()
				.getRoute("managerReports")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		/**
		 * …#/ManagerReports?card=DIVISION - the card the user came from, turned
		 * into the service's ImManagerType AND into the depth the "כפיפים" filter
		 * opens on. No card (a direct entry, a bookmark) means מנהל ישיר / TMGR /
		 * ישירים בלבד.
		 *
		 * נוכחות כפיפים opens on "ישירים בלבד" - only the people this user manages
		 * personally. Every other card opens on "כל הכפיפים", because an אגף is a
		 * subtree: a report of a report is still in it.
		 *
		 * The כפיפים filter is written here on EVERY entry and not with the rest of
		 * the defaults, which are applied once. It is not a default - it is what
		 * the card asked for, so arriving from a different card has to move it even
		 * though the user has been on this screen before.
		 */
		_onRouteMatched: function (oEvent) {
			var oQuery = (oEvent.getParameter("arguments") || {})["?query"] || {};

			this._sManagerType = DataService.getManagerType(oQuery.card);
			this._sSubordinateScope = DataService.getSubordinateScope(oQuery.card);
			// re-read on every entry, for the same reason _sManagerType is: a user
			// with two roles arrives here from a different card each time
			this._oRoleDefaults = DataService.getRoleDefaults(this._sManagerType);
			this.getView().byId("subordinatesFilter").setSelectedKey(this._sSubordinateScope);

			this._loadReminderTemplate();
			// the option lists first, so the filter bar is already populated by the
			// time the rows underneath it arrive
			this._loadContext().then(this._loadData.bind(this));
		},

		/**
		 * The shared manager context: who the user is, and the four option lists.
		 *
		 * Cached in the DataService, so this is a round trip only on the first
		 * screen of the session and after a רענון - every other entry is free.
		 *
		 * A failure here is not fatal: the option lists stay as they were and the
		 * table still loads, so a user whose filters are stale can still read their
		 * reports. Only the rows are worth stopping for.
		 *
		 * @returns {Promise} always resolves
		 */
		_loadContext: function () {
			return DataService.loadManagerContext(this.getOwnerComponent())
				.then(function (oContext) {
					this._oCurrentUser = oContext.user;
					// _oRoleDefaults is NOT re-read here: it belongs to the card
					// this screen was opened from, which the route already settled,
					// and oContext.user.role is the widest role the user holds -
					// a different question with a different answer.
					this._applyContextOptions(oContext.filterOptions);

					// The defaults depend on the level the user turned out to hold,
					// which onInit could not know - so they are applied once the
					// answer is in, and only on the first entry: coming back to this
					// screen must not throw away the filters the user left on it.
					if (!this._bDefaultsApplied) {
						this._bDefaultsApplied = true;
						this._setDefaultFilters();
					}
				}.bind(this))
				.catch(function (oErr) {
					// eslint-disable-next-line no-console
					window.console && window.console.error("loadManagerContext failed", oErr);
				});
		},

		/**
		 * Replaces the four data-driven option lists with the ones the shared call
		 * produced, keeping any selection the new lists still offer.
		 *
		 * Keeping rather than clearing, because this also runs on a רענון: a user
		 * who has narrowed to one אגף and pressed refresh means "the same view,
		 * fresher" - and a key the new list no longer has would filter the table
		 * silently away, so that one is the only kind that is dropped.
		 *
		 * @param {object} oOptions {populations, branches, units, managers}
		 */
		_applyContextOptions: function (oOptions) {
			var oOptionsModel = this.getView().getModel("options");
			var oView = this.getView();

			DATA_DRIVEN_FILTERS.forEach(function (oFilter) {
				var aItems = oOptions[oFilter.optionsKey] || [];
				var oControl = oView.byId(oFilter.controlId);
				var aKept = oControl.getSelectedKeys().filter(function (sKey) {
					return aItems.some(function (oItem) { return oItem.key === sKey; });
				});

				oOptionsModel.setProperty("/" + oFilter.optionsKey, aItems);
				oControl.setSelectedKeys(aKept);
			});
		},

		/**
		 * רענון - back to the service for both halves of the screen: the shared
		 * context behind the filter lists, and the rows of the table.
		 */
		onRefresh: function () {
			DataService.invalidateManagerContext();
			this._loadContext().then(this._loadData.bind(this));
		},

		/**
		 * Applies the default filter selection:
		 *   - current year + current month
		 *   - status tab + "נמצא בטיפול" per the user's role
		 *   - "שם מנהל ישיר" = the current user
		 *   - "כפיפים" = the depth the card opened the screen on
		 *   - "ממתינים לאישור מחודשים קודמים" = off
		 */
		_setDefaultFilters: function () {
			var oNow = new Date();
			var oView = this.getView();
			oView.byId("searchField").setValue("");
			oView.byId("yearFilter").setSelectedKeys([String(oNow.getFullYear())]);
			oView.byId("monthFilter").setSelectedKeys([String(oNow.getMonth() + 1)]);
			oView.byId("populationFilter").setSelectedKeys([]);
			oView.byId("branchFilter").setSelectedKeys([]);
			oView.byId("unitFilter").setSelectedKeys([]);

			// שם מנהל ישיר opens on the user themselves, so the screen lands on
			// their own direct reports - but only if the option list actually
			// offers them. The key is the manager's NAME, because that is all
			// ManagerEmployees carries, and a name that is not in the list would
			// match no row and empty the table rather than narrow it.
			var sSelf = this._oCurrentUser.displayName;
			var bSelfListed = (this.getView().getModel("options").getProperty("/managers") || [])
				.some(function (oItem) { return oItem.key === sSelf; });
			oView.byId("managerFilter").setSelectedKeys(bSelfListed ? [sSelf] : []);
			oView.byId("handledByFilter").setSelectedKeys([this._oRoleDefaults.handledByKey]);
			// back to what the CARD asked for, not to a fixed value: "איפוס
			// פילטרים" returns the screen to how it opened, and it opened on the
			// depth the card chose
			oView.byId("subordinatesFilter").setSelectedKey(this._sSubordinateScope);
			oView.byId("statusTabBar").setSelectedKey(this._oRoleDefaults.statusTab);

			// The toggle is part of the filter state, so "איפוס פילטרים" clears it
			// as well; the Switch follows the model through its two-way binding.
			oView.getModel("view").setProperty("/oldReports", false);
		},

		/**
		 * "איפוס פילטרים" - reset the filters back to their defaults.
		 * The period is part of the reset, so this re-asks the service rather than
		 * re-filtering the rows of the period that was on screen a moment ago.
		 */
		onResetFilters: function () {
			this._setDefaultFilters();
			this._loadData();
		},

		/**
		 * "ממתינים לאישור מחודשים קודמים".
		 *
		 * Not one more narrowing of what is on screen: it asks the service a
		 * different question - what is still open from the months that have
		 * already gone by - so switching it ON starts from a clean bar. Every
		 * other filter goes back to its default and חודש is cleared to "הכל",
		 * because that default is the CURRENT month, i.e. the one month this
		 * toggle is not about: left standing it would filter away exactly the
		 * rows that were just asked for.
		 *
		 * שנה is the one filter it sets rather than clears - see oldReportsYear.
		 *
		 * Switching it OFF leaves the bar as the user has it and only re-asks
		 * without the flag, so the year they ended up on is where they carry on.
		 */
		onToggleOldReports: function (oEvent) {
			var bOn = oEvent.getParameter("state");
			var oView = this.getView();

			if (bOn) {
				// _setDefaultFilters also clears /oldReports - the flag is written
				// back below, once the bar underneath it is the one it expects.
				this._setDefaultFilters();
				oView.byId("monthFilter").setSelectedKeys([]);
				oView.byId("yearFilter").setSelectedKeys([String(oldReportsYear())]);
			}
			oView.getModel("view").setProperty("/oldReports", bOn);

			// part of the REQUEST, like שנה / חודש - not a client-side filter
			this._loadData();
		},

		/** Expand / collapse the advanced filter area (the arrow toggle). */
		onToggleFilters: function () {
			var oModel = this.getView().getModel("view");
			oModel.setProperty("/filtersExpanded", !oModel.getProperty("/filtersExpanded"));
		},

		/**
		 * "נמצא בטיפול": keeps the "כל הגורמים המאשרים" (ALL) item mutually
		 * exclusive with the specific parties, then mirrors the selection onto
		 * the status tabs.
		 */
		onHandledByChange: function (oEvent) {
			var oMcb = oEvent.getSource();
			var oParams = oEvent.getParameters();
			var sChangedKey = oParams.changedItem && oParams.changedItem.getKey();
			var aKeys = oMcb.getSelectedKeys();

			if (oParams.selected && sChangedKey === ALL) {
				oMcb.setSelectedKeys([ALL]);
			} else if (oParams.selected && aKeys.indexOf(ALL) !== -1) {
				oMcb.setSelectedKeys(aKeys.filter(function (sKey) { return sKey !== ALL; }));
			}

			this._syncTabToHandledBy();
			this._applyFilters();
		},

		/**
		 * "נמצא בטיפול" -> status tabs.
		 *
		 * A single party that has a tab of its own selects that tab; anything
		 * else - nothing selected, "כל הגורמים המאשרים", more than one party,
		 * or a party with no matching tab (שליחות) - falls back to "הכל",
		 * because no single tab can express it.
		 */
		_syncTabToHandledBy: function () {
			var aKeys = this.getView().byId("handledByFilter").getSelectedKeys()
				.filter(function (sKey) { return sKey !== ALL; });
			var sTab = (aKeys.length === 1 && PARTY_TO_TAB[aKeys[0]]) || ALL;
			this.getView().byId("statusTabBar").setSelectedKey(sTab);
		},

		/**
		 * Status tabs -> "נמצא בטיפול".
		 *
		 * The three waiting tabs each select their one party. "הכל" and "אושרו"
		 * have no single handling party, so they reset the field to
		 * "כל הגורמים המאשרים".
		 */
		_syncHandledByToTab: function () {
			var sTab = this.getView().byId("statusTabBar").getSelectedKey();
			var sParty = TAB_TO_PARTY[sTab];
			this.getView().byId("handledByFilter").setSelectedKeys([sParty || ALL]);
		},

		/**
		 * Loads the rows from the DataService and refreshes the screen.
		 *
		 * Called on entry and again whenever the requested PERIOD changes: שנה and
		 * חודש are the only request parameters left in the bar (ImBeginDate /
		 * ImEndDate are mandatory on the service), not client-side filters like the
		 * rest of it. They stay in
		 * _buildBaseFilters as well, which costs nothing and keeps the counts right
		 * when the backend answers with a wider span than it was asked for.
		 */
		_loadData: function () {
			var oView = this.getView();
			var oPeriod = buildPeriod(
				oView.byId("yearFilter").getSelectedKeys(),
				oView.byId("monthFilter").getSelectedKeys()
			);

			oView.setBusy(true);

			DataService.getManagerReports(this.getOwnerComponent(), {
				managerType: this._sManagerType,
				managerUser: this._oCurrentUser.userId,
				beginDate: oPeriod.begin,
				endDate: oPeriod.end,
				oldReports: oView.getModel("view").getProperty("/oldReports")
			})
				.then(function (aItems) {
					this._aAllItems = aItems || [];
					this._bMockData = DataService.isLastLoadMock();

					// The four data-driven option lists are NOT rebuilt here. They
					// belong to the shared context (_applyContextOptions) and move
					// only on a refresh - so narrowing the period cannot take away
					// an אגף the user was about to pick.
					this._alignStatusTab();

					this._oReportsModel.setProperty("/items", this._aAllItems);
					this._applyFilters();
					this._noteMockData();
					oView.setBusy(false);
				}.bind(this))
				.catch(function (oErr) {
					oView.setBusy(false);
					MessageToast.show(this._getText("mrErrorLoading"));
					// eslint-disable-next-line no-console
					window.console && window.console.error("getManagerReports failed", oErr);
				}.bind(this));
		},

		/**
		 * The status tabs need a status on the row, and ManagerEmployees does not
		 * carry one yet. Landing on "ממתין למנהל" would then show an empty table
		 * over rows that did arrive - so when nothing carries a status the screen
		 * falls back to "הכל", which is the honest view of statusless data.
		 *
		 * Remove this once the service returns the approval columns.
		 */
		_alignStatusTab: function () {
			var bHasStatus = (this._aAllItems || []).some(function (oItem) {
				return !!oItem.status;
			});

			if (!bHasStatus && this._aAllItems.length) {
				this.getView().byId("statusTabBar").setSelectedKey(ALL);
				this._syncHandledByToTab();
			}
		},

		/**
		 * Says so, once per screen entry, when the rows on screen are demo data -
		 * which on a development machine they always are, by design
		 * (DataService.isMockEnvironment).
		 */
		_noteMockData: function () {
			if (this._bMockData && !this._bMockNoticeShown) {
				this._bMockNoticeShown = true;
				MessageToast.show(this._getText("mrMockNotice"));
			}
		},

		/* =============================== filtering =============================== */

		onSearch: function () {
			this._applyFilters();
		},

		onFilterChange: function () {
			this._applyFilters();
		},

		/**
		 * שנה / חודש - the parts of the filter bar that are part of the REQUEST, so
		 * changing one re-asks the service instead of narrowing what is already on
		 * screen. Everything else filters client-side, as before.
		 */
		onRequestFilterChange: function () {
			this._loadData();
		},

		onStatusSelect: function () {
			this._syncHandledByToTab();
			this._applyFilters();
		},

		/** Reads the current UI state into a plain object. */
		_readFilterState: function () {
			var oView = this.getView();
			var fnKeys = function (sId) {
				return oView.byId(sId).getSelectedKeys();
			};

			// On both controls "ALL" is the pseudo-key for "no restriction".
			var sStatus = oView.byId("statusTabBar").getSelectedKey();
			var aHandledBy = fnKeys("handledByFilter").filter(function (s) { return s !== ALL; });

			// The tabs and the field are two views of the same dimension, so a
			// field selection that merely mirrors the selected tab must not
			// filter a second time - it would also flatten the counts on every
			// other tab, since they are computed over everything except status.
			if (aHandledBy.length === 1 && TAB_TO_PARTY[sStatus] === aHandledBy[0]) {
				aHandledBy = [];
			}

			return {
				search: (oView.byId("searchField").getValue() || "").trim().toLowerCase(),
				years: fnKeys("yearFilter"),
				months: fnKeys("monthFilter"),
				populations: fnKeys("populationFilter"),
				branches: fnKeys("branchFilter"),
				units: fnKeys("unitFilter"),
				managers: fnKeys("managerFilter"),
				handledBy: aHandledBy,
				directOnly: oView.byId("subordinatesFilter").getSelectedKey() === "DIRECT",
				status: sStatus === ALL ? "" : sStatus
			};
		},

		/**
		 * Applies the filters to the table binding, and recomputes the tab
		 * counts + the table title. Everything is data-driven, so once the
		 * DataService returns real rows this "just works".
		 */
		_applyFilters: function () {
			var oState = this._readFilterState();

			// --- filters that also affect the tab counts (everything except status) ---
			var aBaseFilters = this._buildBaseFilters(oState);

			// --- table binding = base filters + selected status tab ---
			var aTableFilters = aBaseFilters.slice();
			if (oState.status) {
				aTableFilters.push(new Filter("status", FilterOperator.EQ, oState.status));
			}
			var oBinding = this.byId("reportsTable").getBinding("items");
			if (oBinding) {
				oBinding.filter(aTableFilters);
			}

			// --- recompute counts + title ---
			this._recomputeCounts(oState);
			this._updateTitle(oState);
		},

		/** Builds the sap.ui.model.Filter array for everything except the status tab. */
		_buildBaseFilters: function (oState) {
			var aFilters = [];

			if (oState.search) {
				aFilters.push(new Filter({
					filters: [
						new Filter("employeeName", FilterOperator.Contains, oState.search),
						new Filter("employeeNumber", FilterOperator.Contains, oState.search),
						new Filter("branch", FilterOperator.Contains, oState.search),
						new Filter("unit", FilterOperator.Contains, oState.search),
						new Filter("managerName", FilterOperator.Contains, oState.search)
					],
					and: false
				}));
			}
			this._pushMultiFilter(aFilters, "approvalYearKey", oState.years);
			this._pushMultiFilter(aFilters, "approvalMonthKey", oState.months);
			this._pushMultiFilter(aFilters, "populationKey", oState.populations);
			this._pushMultiFilter(aFilters, "branchKey", oState.branches);
			this._pushMultiFilter(aFilters, "unitKey", oState.units);
			this._pushMultiFilter(aFilters, "managerKey", oState.managers);
			this._pushMultiFilter(aFilters, "handledByKey", oState.handledBy);
			if (oState.directOnly) {
				aFilters.push(new Filter("isDirect", FilterOperator.EQ, true));
			}

			return aFilters;
		},

		/** OR-combines a multi-select filter and pushes it as one AND term. */
		_pushMultiFilter: function (aTarget, sPath, aKeys) {
			if (aKeys && aKeys.length) {
				aTarget.push(new Filter({
					filters: aKeys.map(function (sKey) {
						return new Filter(sPath, FilterOperator.EQ, sKey);
					}),
					and: false
				}));
			}
		},

		/**
		 * Counts per status over the data filtered by everything EXCEPT status,
		 * so the tab badges reflect the current filter context.
		 */
		_recomputeCounts: function (oState) {
			var oCounts = {
				ALL: 0,
				PENDING_EMPLOYEE: 0,
				PENDING_MY_APPROVAL: 0,
				PENDING_HR: 0,
				APPROVED: 0
			};
			(this._aAllItems || []).forEach(function (oItem) {
				if (!this._matchesBase(oItem, oState)) {
					return;
				}
				// "הכל" counts every row in the filter context, including one whose
				// status the service did not send - it is still a report on screen,
				// and a row the table shows but no tab counts reads as a bug.
				oCounts.ALL++;
				if (oItem.status && oCounts.hasOwnProperty(oItem.status)) {
					oCounts[oItem.status]++;
				}
			}.bind(this));
			// IconTabFilter.count is a string property - coerce.
			Object.keys(oCounts).forEach(function (sKey) {
				oCounts[sKey] = String(oCounts[sKey]);
			});
			this.getView().getModel("view").setProperty("/statusCounts", oCounts);
		},

		/** Plain-JS mirror of _buildBaseFilters, used for counting. */
		_matchesBase: function (oItem, oState) {
			if (oState.search) {
				var sHay = [oItem.employeeName, oItem.employeeNumber, oItem.branch,
					oItem.unit, oItem.managerName].join(" ").toLowerCase();
				if (sHay.indexOf(oState.search) === -1) {
					return false;
				}
			}
			if (oState.directOnly && !oItem.isDirect) {
				return false;
			}
			var fnIn = function (aKeys, sVal) {
				return !aKeys.length || aKeys.indexOf(sVal) !== -1;
			};
			return fnIn(oState.years, oItem.approvalYearKey)
				&& fnIn(oState.months, oItem.approvalMonthKey)
				&& fnIn(oState.populations, oItem.populationKey)
				&& fnIn(oState.branches, oItem.branchKey)
				&& fnIn(oState.units, oItem.unitKey)
				&& fnIn(oState.managers, oItem.managerKey)
				&& fnIn(oState.handledBy, oItem.handledByKey);
		},

		_updateTitle: function (oState) {
			var oCounts = this.getView().getModel("view").getProperty("/statusCounts");
			var sLabelKey = STATUS_LABEL_KEY[oState.status];
			// oState.status is "" on the "הכל" tab - there is no single status
			// to name, so the title just counts everything in view.
			var sTitle = oState.status
				? this._getText("mrTitlePending", [
					sLabelKey ? this._getText(sLabelKey) : "",
					String(oCounts[oState.status] || 0)
				])
				: this._getText("mrTitleAll", [String(oCounts.ALL || 0)]);
			this.getView().getModel("view").setProperty("/tableTitle", sTitle);
		},

		/* =============================== sorting =============================== */

		onOpenViewSettings: function () {
			if (!this._oSortDialog) {
				this._oSortDialog = new ViewSettingsDialog({
					title: this._getText("mrSortTitle"),
					confirm: this._onSortConfirm.bind(this),
					// the sort items ARE the columns, so they take the column labels
					sortItems: [
						new ViewSettingsItem({ key: "employeeName", text: this._getText("mrColEmployeeName") }),
						new ViewSettingsItem({ key: "employeeNumber", text: this._getText("mrColEmployeeNumber") }),
						new ViewSettingsItem({ key: "approvalMonthKey", text: this._getText("mrColApprovalMonth") }),
						new ViewSettingsItem({ key: "population", text: this._getText("mrColPopulation") }),
						new ViewSettingsItem({ key: "branch", text: this._getText("mrColBranch") })
					]
				});
				this.getView().addDependent(this._oSortDialog);
			}
			this._oSortDialog.open();
		},

		_onSortConfirm: function (oEvent) {
			var oParams = oEvent.getParameters();
			var oBinding = this.byId("reportsTable").getBinding("items");
			if (oParams.sortItem) {
				oBinding.sort(new Sorter(oParams.sortItem.getKey(), oParams.sortDescending));
			} else {
				oBinding.sort([]);
			}
		},

		/* =============================== export =============================== */

		onExport: function () {
			var oTable = this.byId("reportsTable");
			var oBinding = oTable.getBinding("items");

			var aCols = [
				{ label: this._getText("mrColEmployeeName"), property: "employeeName" },
				{ label: this._getText("mrColEmployeeNumber"), property: "employeeNumber" },
				{ label: this._getText("mrColPopulation"), property: "population" },
				{ label: this._getText("mrColBranch"), property: "branch" },
				{ label: this._getText("mrColUnit"), property: "unit" },
				{ label: this._getText("mrColDirectManager"), property: "managerName" },
				{ label: this._getText("mrColApprovalMonth"), property: "approvalMonth" },
				{ label: this._getText("mrColProcess"), property: "processStep", type: "Number" }
			];

			var sFileName = this._getText("mrExportFileName") + ".xlsx";

			sap.ui.require(["sap/ui/export/Spreadsheet"], function (Spreadsheet) {
				var oSheet = new Spreadsheet({
					workbook: { columns: aCols },
					dataSource: {
						type: "json",
						data: oBinding.getContexts(0, oBinding.getLength()).map(function (oCtx) {
							return oCtx.getObject();
						})
					},
					fileName: sFileName
				});
				oSheet.build().finally(function () {
					oSheet.destroy();
				});
			});
		},

		/* ============================ שליחת תזכורת ============================ */

		/**
		 * The text the dialog opens with, asked for once per entry to the screen.
		 *
		 * The service owns the wording and the month it names - see
		 * DataService.getReminderTemplate - so this is a fetch, not a constant.
		 *
		 * What is kept is the PROMISE and not its result: a user who reaches the
		 * button before the answer does then opens on the answer instead of on an
		 * empty box. A failure resolves to empty fields rather than rejecting -
		 * writing the message by hand is worse than not having to, and much better
		 * than a button that does nothing.
		 */
		_loadReminderTemplate: function () {
			this._pReminderTemplate = DataService.getReminderTemplate({
				managerUser: this._oCurrentUser.userId,
				managerType: this._sManagerType
			}).catch(function (oErr) {
				// eslint-disable-next-line no-console
				window.console && window.console.error("getReminderTemplate failed", oErr);
				return { subject: "", body: "" };
			});
		},

		/** שליחת תזכורת - the compose dialog, always opened on the defaults. */
		onOpenReminder: function () {
			if (!this._pReminderDialog) {
				this._pReminderDialog = Fragment.load({
					id: this.getView().getId(),
					name: "modtimesheet.view.ManagerReportsReminder",
					controller: this
				}).then(function (oDialog) {
					this.getView().addDependent(oDialog);
					this._prepareRecipientInput();
					return oDialog;
				}.bind(this));
			}

			this._pReminderDialog.then(function (oDialog) {
				// filled first, opened second - the dialog is never on screen holding
				// the text of the previous send, not even for one frame
				return this._resetReminder().then(function () {
					oDialog.open();
				});
			}.bind(this));
		},

		/**
		 * Lets the sender add an address by typing it.
		 *
		 * A MultiInput with no validator drops whatever is typed into it the moment
		 * it loses focus, without a word - so אל is not really editable until this
		 * is attached. Added once, when the fragment is created.
		 */
		_prepareRecipientInput: function () {
			var oInput = this.byId("reminderTo");
			if (!oInput) {
				return;
			}

			oInput.addValidator(function (oArgs) {
				var sText = (oArgs.text || "").trim();
				if (!sText) {
					return null;
				}
				if (!EMAIL_PATTERN.test(sText)) {
					MessageToast.show(this._getText("mrInvalidEmail", [sText]));
					return null;
				}
				return new Token({ key: sText, text: sText });
			}.bind(this));
		},

		/**
		 * The state the dialog opens in, every time: אל from the table as it stands
		 * right now, כותרת and תוכן from the service.
		 *
		 * This is also what ביטול is made of. Nothing is rolled back when the dialog
		 * closes - an edit that was not sent simply does not survive the next open,
		 * which is the same rule for ביטול, for the X, and for a send that went out
		 * an hour ago.
		 *
		 * @returns {Promise} resolves once the fields hold the defaults
		 */
		_resetReminder: function () {
			var oViewModel = this.getView().getModel("view");
			var oInput = this.byId("reminderTo");

			if (oInput) {
				oInput.setValue("");
				oInput.destroyTokens();
				this._collectRecipients().forEach(function (sMail) {
					oInput.addToken(new Token({ key: sMail, text: sMail }));
				});
			}

			// The fetch is started by _onRouteMatched, which the dialog cannot be
			// opened before - the fallback is for a route that never matched.
			var pTemplate = this._pReminderTemplate
				|| Promise.resolve({ subject: "", body: "" });

			return pTemplate.then(function (oTemplate) {
				// kept for the payload: the period that was SENT is the one the
				// service named, never one re-derived from the clock at send time
				this._oReminderTemplate = oTemplate;
				oViewModel.setProperty("/reminder", {
					subject: oTemplate.subject,
					body: oTemplate.body
				});
			}.bind(this));
		},

		/**
		 * The addresses אל opens with: the EMAIL column of the rows the table is
		 * showing at this moment - the same set ייצוא לאקסל writes out, and for the
		 * same reason. The filter bar above the table is what decides who is being
		 * chased, so the reminder follows it rather than the whole load.
		 *
		 * De-duplicated, because one address can carry several reports (in the mock
		 * it carries three or four). A row with no address is skipped rather than
		 * turned into an empty recipient.
		 *
		 * @returns {string[]} the addresses, in the table's own order
		 */
		_collectRecipients: function () {
			var oBinding = this.byId("reportsTable").getBinding("items");
			var aContexts = oBinding ? oBinding.getContexts(0, oBinding.getLength()) : [];
			var oSeen = {};

			return aContexts.reduce(function (aMails, oCtx) {
				var sMail = ((oCtx.getObject() || {}).employeeMail || "").trim();
				if (sMail && !oSeen[sMail]) {
					oSeen[sMail] = true;
					aMails.push(sMail);
				}
				return aMails;
			}, []);
		},

		/**
		 * שלח - builds the payload and hands it to the service.
		 *
		 * אל is read off the control and not off the model: the tokens are what the
		 * sender sees, and one they removed a second ago must not travel. כותרת and
		 * תוכן come from the model, which their two-way bindings keep current.
		 *
		 * The dialog stays open, busy, until the service answers: a send that failed
		 * behind a dialog which had already closed would take the message with it.
		 *
		 * Success is a toast and failure is a MessageBox, and the asymmetry is the
		 * point: "נשלח" needs no acknowledgement and should not interrupt, while a
		 * failure carries the backend's own text, has to be read, and leaves the
		 * sender with the composed message still in front of them to retry.
		 */
		onSendReminder: function () {
			var oDialog = this.byId("reminderDialog");
			var oReminder = this.getView().getModel("view").getProperty("/reminder") || {};
			var oTemplate = this._oReminderTemplate || {};
			var aTo = this.byId("reminderTo").getTokens().map(function (oToken) {
				return oToken.getKey() || oToken.getText();
			});

			if (!aTo.length) {
				MessageToast.show(this._getText("mrReminderNoRecipients"));
				return;
			}

			var oPayload = {
				to: aTo,
				subject: oReminder.subject || "",
				body: oReminder.body || "",
				periodMonth: oTemplate.periodMonth,
				periodYear: oTemplate.periodYear,
				managerUser: this._oCurrentUser.userId,
				managerType: this._sManagerType
			};

			oDialog.setBusy(true);
			DataService.sendReminder(this.getOwnerComponent(), oPayload).then(function () {
				oDialog.setBusy(false);
				oDialog.close();
				MessageToast.show(aTo.length === 1
					? this._getText("mrReminderSentOne")
					: this._getText("mrReminderSentMany", [String(aTo.length)]));
			}.bind(this)).catch(function (oErr) {
				oDialog.setBusy(false);
				// The service's own message, which is the only one that says
				// anything useful; the generic line is for an error that arrived
				// without one.
				var sFailed = this._getText("mrReminderFailed");
				MessageBox.error((oErr && oErr.message) || sFailed, { title: sFailed });
				// eslint-disable-next-line no-console
				window.console && window.console.error("sendReminder failed", oErr);
			}.bind(this));
		},

		/** ביטול - closes without sending; see _resetReminder for why that is enough. */
		onCancelReminder: function () {
			var oDialog = this.byId("reminderDialog");
			if (oDialog) {
				oDialog.close();
			}
		},

		/* =============================== navigation =============================== */

		onOpenReport: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext("reports");
			var oRow = oCtx.getObject();
			// TODO: navigate to the report detail. Placeholder for now:
			MessageToast.show(this._getText("mrOpenReportPlaceholder",
				[oRow.employeeName, oRow.employeeNumber]));
		},

		/** היעדרויות - leaves for that employee's absences screen. */
		onOpenAbsences: function (oEvent) {
			// TODO: wire up once the absences screen exists:
			// this.getOwnerComponent().getRouter().navTo("employeeAbsences", {
			//     employeeId: oRow.employeeId
			// });
			this._toastRowAction(oEvent, "mrOpenAbsencesPlaceholder");
		},

		/** השתלמויות - leaves for that employee's training screen. */
		onOpenTraining: function (oEvent) {
			// TODO: wire up once the training screen exists:
			// this.getOwnerComponent().getRouter().navTo("employeeTraining", {
			//     employeeId: oRow.employeeId
			// });
			this._toastRowAction(oEvent, "mrOpenTrainingPlaceholder");
		},

		/**
		 * Placeholder for the row-action icons until their screens exist: names the
		 * employee whose row was pressed, so it is visible that the press reached the
		 * right record and not just the right column.
		 *
		 * @param {sap.ui.base.Event} oEvent   press event of a row-action Button
		 * @param {string}            sWhatKey i18n key naming what is being opened
		 */
		_toastRowAction: function (oEvent, sWhatKey) {
			var oRow = oEvent.getSource().getBindingContext("reports").getObject();
			MessageToast.show(this._getText("mrRowActionPlaceholder",
				[this._getText(sWhatKey), oRow.employeeName, oRow.employeeNumber]));
		},

		/**
		 * @param {string} sKey    i18n key
		 * @param {any[]}  [aArgs] placeholder values
		 * @returns {string} the translated text
		 */
		_getText: function (sKey, aArgs) {
			return this.getOwnerComponent().getModel("i18n")
				.getResourceBundle().getText(sKey, aArgs);
		}
	});
});
