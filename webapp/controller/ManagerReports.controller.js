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

	return Controller.extend("modtimesheet.controller.ManagerReports", {

		formatter: formatter,

		/* =============================== lifecycle =============================== */

		onInit: function () {
			// logged-in user + the defaults their role implies
			this._oCurrentUser = DataService.getCurrentUser();
			this._oRoleDefaults = DataService.getRoleDefaults(this._oCurrentUser.role);

			// filter drop-down options
			this.getView().setModel(new JSONModel(DataService.getFilterOptions()), "options");

			// view state (counts, title, advanced-filters toggle)
			this.getView().setModel(new JSONModel({
				statusCounts: {
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

			// role / user driven defaults
			oView.byId("managerFilter").setSelectedKeys([this._oCurrentUser.managerKey]);
			oView.byId("handledByFilter").setSelectedKeys([this._oRoleDefaults.handledByKey]);
			oView.byId("subordinatesFilter").setSelectedKey("DIRECT");
			oView.byId("statusTabBar").setSelectedKey(this._oRoleDefaults.statusTab);
		},

		/** "איפוס פילטרים" - reset the filters back to their defaults. */
		onResetFilters: function () {
			this._setDefaultFilters();
			this._applyFilters();
		},

		/** Expand / collapse the advanced filter area (the arrow toggle). */
		onToggleFilters: function () {
			var oModel = this.getView().getModel("view");
			oModel.setProperty("/filtersExpanded", !oModel.getProperty("/filtersExpanded"));
		},

		/**
		 * "נמצא בטיפול": keeps the "כל הגורמים המאשרים" (ALL) item mutually
		 * exclusive with the specific parties.
		 */
		onHandledByChange: function (oEvent) {
			var oMcb = oEvent.getSource();
			var oParams = oEvent.getParameters();
			var sChangedKey = oParams.changedItem && oParams.changedItem.getKey();
			var aKeys = oMcb.getSelectedKeys();

			if (oParams.selected && sChangedKey === "ALL") {
				oMcb.setSelectedKeys(["ALL"]);
			} else if (oParams.selected && aKeys.indexOf("ALL") !== -1) {
				oMcb.setSelectedKeys(aKeys.filter(function (sKey) { return sKey !== "ALL"; }));
			}
			this._applyFilters();
		},

		/**
		 * Loads the rows from the DataService and refreshes the screen.
		 * Called on init and whenever you want to re-fetch.
		 */
		_loadData: function () {
			var oView = this.getView();
			oView.setBusy(true);

			DataService.getManagerReports(this.getOwnerComponent())
				.then(function (aItems) {
					this._aAllItems = aItems || [];
					this._oReportsModel.setProperty("/items", this._aAllItems);
					this._applyFilters();
					oView.setBusy(false);
				}.bind(this))
				.catch(function (oErr) {
					oView.setBusy(false);
					MessageToast.show("טעינת הנתונים נכשלה");
					// eslint-disable-next-line no-console
					window.console && window.console.error("getManagerReports failed", oErr);
				});
		},

		/* =============================== filtering =============================== */

		onSearch: function () {
			this._applyFilters();
		},

		onFilterChange: function () {
			this._applyFilters();
		},

		onStatusSelect: function () {
			this._applyFilters();
		},

		/** Reads the current UI state into a plain object. */
		_readFilterState: function () {
			var oView = this.getView();
			var fnKeys = function (sId) {
				return oView.byId(sId).getSelectedKeys();
			};
			return {
				search: (oView.byId("searchField").getValue() || "").trim().toLowerCase(),
				reportType: oView.byId("reportTypeSelect").getSelectedKey(),
				years: fnKeys("yearFilter"),
				months: fnKeys("monthFilter"),
				populations: fnKeys("populationFilter"),
				branches: fnKeys("branchFilter"),
				units: fnKeys("unitFilter"),
				managers: fnKeys("managerFilter"),
				// drop the "ALL" pseudo-key -> means "no restriction"
				handledBy: fnKeys("handledByFilter").filter(function (s) { return s !== "ALL"; }),
				directOnly: oView.byId("subordinatesFilter").getSelectedKey() === "DIRECT",
				status: oView.byId("statusTabBar").getSelectedKey()
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
				PENDING_EMPLOYEE: 0,
				PENDING_MY_APPROVAL: 0,
				PENDING_HR: 0,
				APPROVED: 0
			};
			(this._aAllItems || []).forEach(function (oItem) {
				if (this._matchesBase(oItem, oState) && oCounts.hasOwnProperty(oItem.status)) {
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
			var sLabel = STATUS_LABEL[oState.status] || "";
			var iCount = oCounts[oState.status] || 0;
			this.getView().getModel("view").setProperty(
				"/tableTitle", "דוחות ממתינים: " + sLabel + " (" + iCount + ")");
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
		}
	});
});
