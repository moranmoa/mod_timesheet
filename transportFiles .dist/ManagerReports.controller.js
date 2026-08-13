sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/model/json/JSONModel",
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/ui/model/Sorter",
	"sap/m/ViewSettingsDialog",
	"sap/m/ViewSettingsItem",
	"sap/m/MessageToast",
	"modtimesheet/model/DataService",
	"modtimesheet/model/formatter"
], function (Controller, JSONModel, Filter, FilterOperator, Sorter,
	ViewSettingsDialog, ViewSettingsItem, MessageToast, DataService, formatter) {
	"use strict";

	// Labels used for the table title, keyed by status.
	var STATUS_LABEL = {
		PENDING_EMPLOYEE: "לעובד",
		PENDING_MY_APPROVAL: "לטיפולי",
		PENDING_HR: 'למשא"ן',
		APPROVED: "שאושרו"
	};

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
	 * On real rows these four are rebuilt from what the service returned
	 * (DataService.deriveFilterOptions), so a selection left over from the mock
	 * lists - "M1", "B1" - cannot silently empty the table.
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

	return Controller.extend("modtimesheet.controller.ManagerReports", {

		formatter: formatter,

		/* =============================== lifecycle =============================== */

		onInit: function () {
			// logged-in user + the defaults their role implies
			this._oCurrentUser = DataService.getCurrentUser();
			this._oRoleDefaults = DataService.getRoleDefaults(this._oCurrentUser.role);

			// ImManagerType, until the route says otherwise (see _onRouteMatched)
			this._sManagerType = DataService.getManagerType("");
			// mock until a load says otherwise - it decides whether the mock-only
			// filter defaults (שם ממונה = M1) may be applied at all
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
				filtersExpanded: false
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
		 * into the service's ImManagerType. No card (a direct entry, a bookmark)
		 * means מנהל ישיר / TMGR.
		 */
		_onRouteMatched: function (oEvent) {
			var oQuery = (oEvent.getParameter("arguments") || {})["?query"] || {};

			this._sManagerType = DataService.getManagerType(oQuery.card);
			this._loadData();
		},

		/**
		 * Applies the default filter selection:
		 *   - current year + current month
		 *   - status tab + "נמצא בטיפול" per the user's role
		 *   - "שם ממונה" = the current user
		 *   - "כפיפים" = direct reports only
		 */
		_setDefaultFilters: function () {
			var oNow = new Date();
			var oView = this.getView();
			oView.byId("searchField").setValue("");
			oView.byId("reportTypeSelect").setSelectedKey("ATTENDANCE");
			oView.byId("yearFilter").setSelectedKeys([String(oNow.getFullYear())]);
			oView.byId("monthFilter").setSelectedKeys([String(oNow.getMonth() + 1)]);
			oView.byId("populationFilter").setSelectedKeys([]);
			oView.byId("branchFilter").setSelectedKeys([]);
			oView.byId("unitFilter").setSelectedKeys([]);

			// role / user driven defaults.
			// שם ממונה is preselected only against mock rows: its key there is the
			// mock manager id (M1), while the service returns manager NAMES and no
			// id at all, so preselecting M1 over real data would match nothing and
			// empty the table. The service has already restricted the rows to this
			// user's people anyway - ImManagerUser + ImManagerType do exactly that.
			oView.byId("managerFilter").setSelectedKeys(
				this._bMockData ? [this._oCurrentUser.managerKey] : []
			);
			oView.byId("handledByFilter").setSelectedKeys([this._oRoleDefaults.handledByKey]);
			oView.byId("subordinatesFilter").setSelectedKey("DIRECT");
			oView.byId("statusTabBar").setSelectedKey(this._oRoleDefaults.statusTab);
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
		 * חודש are request parameters (ImBeginDate / ImEndDate are mandatory on the
		 * service), not client-side filters like the rest of the bar. They stay in
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
				reportType: oView.byId("reportTypeSelect").getSelectedKey()
			})
				.then(function (aItems) {
					this._aAllItems = aItems || [];
					this._bMockData = DataService.isLastLoadMock();

					if (!this._bMockData) {
						this._applyDataDrivenOptions(this._aAllItems);
					}
					this._alignStatusTab();

					this._oReportsModel.setProperty("/items", this._aAllItems);
					this._applyFilters();
					this._noteMockData();
					oView.setBusy(false);
				}.bind(this))
				.catch(function (oErr) {
					oView.setBusy(false);
					MessageToast.show("טעינת הנתונים נכשלה");
					// eslint-disable-next-line no-console
					window.console && window.console.error("getManagerReports failed", oErr);
				});
		},

		/**
		 * Replaces the four data-driven option lists with what the service actually
		 * returned, and drops any selection on them: those selections were made
		 * against the previous list, and a key that no longer exists silently
		 * filters everything away.
		 *
		 * @param {object[]} aItems the rows that just arrived
		 */
		_applyDataDrivenOptions: function (aItems) {
			var oOptions = this.getView().getModel("options");
			var oDerived = DataService.deriveFilterOptions(aItems);
			var oView = this.getView();

			DATA_DRIVEN_FILTERS.forEach(function (oFilter) {
				oOptions.setProperty("/" + oFilter.optionsKey, oDerived[oFilter.optionsKey]);
				oView.byId(oFilter.controlId).setSelectedKeys([]);
			});
		},

		/**
		 * The status tabs need a status on the row, and ManagerEmployees does not
		 * carry one yet. Landing on "ממתין לאישורי" would then show an empty table
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
				MessageToast.show("סביבת פיתוח - מוצגים נתוני הדגמה");
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
		 * שנה / חודש / סוג דוח - the parts of the filter bar that are part of the
		 * REQUEST, so changing one re-asks the service instead of narrowing what is
		 * already on screen. Everything else filters client-side, as before.
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
				reportType: oView.byId("reportTypeSelect").getSelectedKey(),
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
			if (oState.reportType) {
				aFilters.push(new Filter("reportType", FilterOperator.EQ, oState.reportType));
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
			if (oState.reportType && oItem.reportType !== oState.reportType) {
				return false;
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
			// oState.status is "" on the "הכל" tab - there is no single status
			// to name, so the title just counts everything in view.
			var sTitle = oState.status
				? "דוחות ממתינים: " + (STATUS_LABEL[oState.status] || "")
					+ " (" + (oCounts[oState.status] || 0) + ")"
				: "כל הדוחות (" + (oCounts.ALL || 0) + ")";
			this.getView().getModel("view").setProperty("/tableTitle", sTitle);
		},

		/* =============================== sorting =============================== */

		onOpenViewSettings: function () {
			if (!this._oSortDialog) {
				this._oSortDialog = new ViewSettingsDialog({
					title: "מיון",
					confirm: this._onSortConfirm.bind(this),
					sortItems: [
						new ViewSettingsItem({ key: "employeeName", text: "שם עובד" }),
						new ViewSettingsItem({ key: "employeeNumber", text: "מספר עובד" }),
						new ViewSettingsItem({ key: "approvalMonthKey", text: "חודש לאישור" }),
						new ViewSettingsItem({ key: "population", text: "אוכלוסייה" }),
						new ViewSettingsItem({ key: "branch", text: "אנף" })
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
				{ label: "שם עובד", property: "employeeName" },
				{ label: "מספר עובד", property: "employeeNumber" },
				{ label: "אוכלוסייה", property: "population" },
				{ label: "אנף", property: "branch" },
				{ label: "יחידה", property: "unit" },
				{ label: "שם ממונה", property: "managerName" },
				{ label: "חודש לאישור", property: "approvalMonth" },
				{ label: "השלמת תהליך", property: "processStep", type: "Number" }
			];

			sap.ui.require(["sap/ui/export/Spreadsheet"], function (Spreadsheet) {
				var oSheet = new Spreadsheet({
					workbook: { columns: aCols },
					dataSource: {
						type: "json",
						data: oBinding.getContexts(0, oBinding.getLength()).map(function (oCtx) {
							return oCtx.getObject();
						})
					},
					fileName: "דוחות_נוכחות.xlsx"
				});
				oSheet.build().finally(function () {
					oSheet.destroy();
				});
			});
		},

		/* =============================== navigation =============================== */

		onOpenReport: function (oEvent) {
			var oCtx = oEvent.getSource().getBindingContext("reports");
			var oRow = oCtx.getObject();
			// TODO: navigate to the report detail. Placeholder for now:
			MessageToast.show("פתיחת דוח: " + oRow.employeeName + " (" + oRow.employeeNumber + ")");
		},

		/** היעדרויות - leaves for that employee's absences screen. */
		onOpenAbsences: function (oEvent) {
			// TODO: wire up once the absences screen exists:
			// this.getOwnerComponent().getRouter().navTo("employeeAbsences", {
			//     employeeId: oRow.employeeId
			// });
			this._toastRowAction(oEvent, "פתיחת מסך היעדרויות");
		},

		/** השתלמויות - leaves for that employee's training screen. */
		onOpenTraining: function (oEvent) {
			// TODO: wire up once the training screen exists:
			// this.getOwnerComponent().getRouter().navTo("employeeTraining", {
			//     employeeId: oRow.employeeId
			// });
			this._toastRowAction(oEvent, "פתיחת מסך השתלמויות");
		},

		/**
		 * Placeholder for the row-action icons until their screens exist: names the
		 * employee whose row was pressed, so it is visible that the press reached the
		 * right record and not just the right column.
		 *
		 * @param {sap.ui.base.Event} oEvent press event of a row-action Button
		 * @param {string}            sWhat  what is being opened
		 */
		_toastRowAction: function (oEvent, sWhat) {
			var oRow = oEvent.getSource().getBindingContext("reports").getObject();
			MessageToast.show(sWhat + ": " + oRow.employeeName + " (" + oRow.employeeNumber + ")");
		}
	});
});
