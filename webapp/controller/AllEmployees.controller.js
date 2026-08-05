sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/ui/core/Fragment",
	"sap/ui/model/json/JSONModel",
	"sap/m/MessageToast",
	"sap/base/Log",
	"modtimesheet/model/formatter",
	"modtimesheet/model/mockEmployees"
], function (Controller, Fragment, JSONModel, MessageToast, Log, formatter, mockEmployees) {
	"use strict";

	/* ============================================================================
	   נתוני כל העובדים - AllEmployees
	   ----------------------------------------------------------------------------
	   Data flow, in one place:

	     backend / mock  ->  FLAT rows              (/employees, never mutated)
	                     ->  filter + sort          (pure helpers below)
	                     ->  flat mode:  /flatEmployees   (bound as-is)
	                     ->  tree mode:  _buildTree(...)  -> /treeEmployees

	   The nested shape is derived, never stored: it is rebuilt from the flat list
	   whenever hierarchy mode is active, and skipped entirely in flat mode.
	   ========================================================================= */

	/** Sort strategies stored in /viewState/sortMode. */
	var SORT_NAME = "name";
	var SORT_HIERARCHY = "hierarchy";

	/**
	 * The three multi-select filters, in one place: which control they drive,
	 * where their option list lives, and which pair of fields on an employee row
	 * the options are distilled from. Everything that iterates the multi-selects -
	 * building the options, reading the criteria, collapsing the tokenizer - reads
	 * this list, so a control id exists in exactly one place.
	 */
	var MULTI_FILTERS = [
		{
			controlId: "aePopulationFilter",
			path: "/filters/populations",
			criteriaKey: "populations",
			keyField: "populationKey",
			textField: "populationText"
		},
		{
			controlId: "aeDivisionFilter",
			path: "/filters/divisions",
			criteriaKey: "divisions",
			keyField: "divisionKey",
			textField: "divisionName"
		},
		{
			controlId: "aeUnitFilter",
			path: "/filters/units",
			criteriaKey: "units",
			keyField: "unitKey",
			textField: "unitName"
		}
	];

	/**
	 * Columns offered in the הגדרות תצוגה dialog, in table order.
	 * Keep this in step with the <t:columns> order in the view - the dialog lists
	 * them in this sequence, so a mismatch reads as a bug to the user.
	 */
	var TOGGLEABLE_COLUMNS = [
		{ columnId: "colEmployeeName", labelKey: "aeColEmployeeName" },
		{ columnId: "colDirectManager", labelKey: "aeColDirectManager" },
		{ columnId: "colEmployeeNumber", labelKey: "aeColEmployeeNumber" },
		{ columnId: "colPopulation", labelKey: "aeColPopulation" },
		{ columnId: "colDivision", labelKey: "aeColDivision" },
		{ columnId: "colUnit", labelKey: "aeColUnit" },
		{ columnId: "colAbsences", labelKey: "aeColAbsences" },
		{ columnId: "colTraining", labelKey: "aeColTraining" }
	];

	/* ============================================================================
	   Module-level pure helpers
	   ----------------------------------------------------------------------------
	   Kept outside the controller object so they cannot reach `this` even by
	   accident. The controller exposes thin methods over them (§8 of the spec)
	   so the unit tests can call either.
	   ========================================================================= */

	/** Hebrew-aware alphabetical comparison on employeeName. */
	function compareByName(oA, oB) {
		return String(oA.employeeName || "").localeCompare(String(oB.employeeName || ""), "he");
	}

	/**
	 * Managers first, then everyone else; alphabetical inside each block.
	 * `isManager` is the flag derived once from the COMPLETE dataset, so a manager
	 * whose subordinates were filtered out still sorts into the first block.
	 */
	function compareByHierarchy(oA, oB) {
		var iA = oA.isManager ? 0 : 1;
		var iB = oB.isManager ? 0 : 1;
		return iA !== iB ? iA - iB : compareByName(oA, oB);
	}

	function getComparator(sMode) {
		return sMode === SORT_HIERARCHY ? compareByHierarchy : compareByName;
	}

	/** An empty (or missing) key list means "no restriction". */
	function inKeySet(aKeys, sValue) {
		return !aKeys || !aKeys.length || aKeys.indexOf(sValue) !== -1;
	}

	/**
	 * Does one flat row satisfy the current search + filter criteria?
	 * The search covers שם עובד, מספר עובד and מנהל ישיר.
	 */
	function matchesCriteria(oRow, oCriteria) {
		var o = oCriteria || {};

		if (o.search) {
			var sHaystack = [oRow.employeeName, oRow.employeeNumber, oRow.managerName]
				.join(" ").toLowerCase();
			if (sHaystack.indexOf(o.search) === -1) {
				return false;
			}
		}

		return inKeySet(o.populations, oRow.populationKey)
			&& inKeySet(o.divisions, oRow.divisionKey)
			&& inKeySet(o.units, oRow.unitKey);
	}

	/**
	 * Deepest `level` in a flattened node list. 0 for a single flat level, so
	 * "open everything" is maxLevel + 1 in TreeTable.expandToLevel terms.
	 */
	function maxLevel(aNodes) {
		return (aNodes || []).reduce(function (iMax, oNode) {
			return Math.max(iMax, oNode.level || 0);
		}, 0);
	}

	/** employeeId -> row, for walking manager chains. */
	function indexById(aFlat) {
		return aFlat.reduce(function (oMap, oRow) {
			oMap[oRow.employeeId] = oRow;
			return oMap;
		}, {});
	}

	/**
	 * Would attaching oRow to its manager close a loop?
	 * Walks up the manager chain; a revisited id means the chain cycles.
	 */
	function isInManagerCycle(oRow, oById) {
		var oSeen = {};
		var oCurrent = oRow;

		while (oCurrent) {
			if (oSeen[oCurrent.employeeId]) {
				return true;
			}
			oSeen[oCurrent.employeeId] = true;
			oCurrent = oCurrent.managerId ? oById[oCurrent.managerId] : null;
		}
		return false;
	}

	return Controller.extend("modtimesheet.controller.AllEmployees", {

		formatter: formatter,

		/* =============================== lifecycle =============================== */

		onInit: function () {
			var oViewModel = new JSONModel({
				viewState: {
					isHierarchy: false,
					sortMode: SORT_NAME,
					busy: false,
					searchTerm: "",
					reportType: "ATTENDANCE",
					currentManagerId: this._getCurrentManagerId(),
					// drives which of the two tree buttons is on screen: false ->
					// פתיחת כל השורות, true -> צמצום כל השורות. Only ever one of them.
					allExpanded: false
				},
				filters: {
					reportTypes: [
						{ key: "ATTENDANCE", text: this._getText("aeReportTypeAttendance") },
						{ key: "ABSENCE", text: this._getText("aeReportTypeAbsence") },
						{ key: "TRAINING", text: this._getText("aeReportTypeTraining") }
					],
					populations: [],
					divisions: [],
					units: []
				},
				group: {
					text: this._getText("aeGroupUnderMyManagement"),
					// live: the number of entries listed directly under the band -
					// the direct reports in tree mode, every matching row in flat mode
					count: 0
				},
				viewSettings: {
					columns: TOGGLEABLE_COLUMNS.map(function (oCol) {
						return {
							columnId: oCol.columnId,
							label: this._getText(oCol.labelKey),
							visible: true
						};
					}, this)
				},
				// the flat list as received - the single source of truth
				employees: [],
				// derived, rebound views of it
				flatEmployees: [],
				treeEmployees: []
			});

			this.getView().setModel(oViewModel, "view");

			this._invalidateTreeCache();

			this.getOwnerComponent().getRouter()
				.getRoute("allEmployees")
				.attachPatternMatched(this._onRouteMatched, this);
		},

		/**
		 * The logged-in manager, whose direct reports form level 0 of the tree.
		 *
		 * TODO: read this from the user context (e.g. the shell's user info service
		 * or a ZHR_USER_SRV call) instead of the mock module.
		 *
		 * @returns {string} employeeId of the current manager
		 */
		_getCurrentManagerId: function () {
			return mockEmployees.getCurrentManager().employeeId;
		},

		/* ========================= routing / data load ========================= */

		_onRouteMatched: function () {
			var oViewModel = this.getView().getModel("view");
			oViewModel.setProperty("/viewState/busy", true);

			// =====================================================================
			// TODO: REPLACE WITH REAL SAP BACKEND CALL
			// ---------------------------------------------------------------------
			// Expected service: ZHR_EMPLOYEES_SRV  (OData V2)
			// EntitySet:        /EmployeeSet
			// The backend returns a FLAT list - one entry per employee, each with
			// its direct manager's ID and name. No $expand is needed; the client
			// builds the hierarchy itself via _buildTree().
			//
			// Field mapping (backend -> model):
			//   Pernr       -> employeeNumber   ("E" + Pernr -> employeeId)
			//   Ename       -> employeeName
			//   MgrPernr    -> managerId
			//   MgrEname    -> managerName        <-- direct manager's name
			//   IsManager   -> isManager          (re-derived, see _deriveIsManager)
			//   Persg/Persk -> populationKey / populationText
			//   OrgehDiv    -> divisionKey / divisionName
			//   OrgehUnit   -> unitKey / unitName
			//
			// var oDataModel = this.getOwnerComponent().getModel();
			// oDataModel.read("/EmployeeSet", {
			//     urlParameters: { "$filter": this._buildBackendFilter() },
			//     success: function (oData) {
			//         this._setEmployeeData(this._mapBackendToFlat(oData.results));
			//     }.bind(this),
			//     error: function () {
			//         MessageToast.show(this._getText("aeErrorLoadingEmployees"));
			//         oViewModel.setProperty("/viewState/busy", false);
			//     }.bind(this)
			// });
			// =====================================================================

			// --- TEMPORARY: mock data for development ---------------------------
			this._setEmployeeData(mockEmployees.getFlat());
			// -------------------------------------------------------------------
		},

		/**
		 * Single entry point for employee data - mock today, backend tomorrow.
		 * Receives a FLAT array. Nesting happens later, on demand, in _buildTree().
		 *
		 * Do NOT put data-shaping logic anywhere else.
		 *
		 * @param {object[]} aFlat flat employee rows
		 */
		_setEmployeeData: function (aFlat) {
			var oViewModel = this.getView().getModel("view");
			var aRows = aFlat || [];

			// once, on the COMPLETE dataset - the hierarchy sort depends on it
			this._deriveIsManager(aRows);

			oViewModel.setProperty("/employees", aRows);

			// the direct reports of the logged-in manager - the design's "(9)".
			// _applyFiltersAndSort below replaces this with the live, filtered count.
			var sRoot = oViewModel.getProperty("/viewState/currentManagerId");
			oViewModel.setProperty("/group/count", aRows.filter(function (oRow) {
				return oRow.managerId === sRoot;
			}).length);

			this._buildFilterOptionsFromData(aRows);
			this._invalidateTreeCache();
			this._applyFiltersAndSort();

			oViewModel.setProperty("/viewState/busy", false);
		},

		/**
		 * Maps the OData V2 payload onto the internal flat shape (§7.2).
		 * Wired up together with the read call in _onRouteMatched.
		 *
		 * @param {object[]} aResults raw /EmployeeSet entries
		 * @returns {object[]} flat employee rows
		 */
		_mapBackendToFlat: function (aResults) {
			return (aResults || []).map(function (oEntry) {
				return {
					employeeId: "E" + oEntry.Pernr,
					employeeNumber: oEntry.Pernr,
					employeeName: oEntry.Ename,
					isManager: oEntry.IsManager === true || oEntry.IsManager === "X",
					managerId: oEntry.MgrPernr ? "E" + oEntry.MgrPernr : null,
					managerName: oEntry.MgrEname || "",
					populationKey: oEntry.Persg,
					populationText: oEntry.PersgTxt,
					divisionKey: oEntry.OrgehDiv,
					divisionName: oEntry.OrgehDivTxt,
					unitKey: oEntry.OrgehUnit,
					unitName: oEntry.OrgehUnitTxt
				};
			});
		},

		/**
		 * $filter for the read call. The report type and the multi-selects are
		 * server-side restrictions once the backend is wired; search stays
		 * client-side because it also has to match מנהל ישיר.
		 *
		 * @returns {string} an OData V2 $filter expression
		 */
		_buildBackendFilter: function () {
			var oViewModel = this.getView().getModel("view");
			var oCriteria = this._readFilterCriteria();
			var aTerms = ["ReportType eq '" + oViewModel.getProperty("/viewState/reportType") + "'"];

			[
				{ field: "Persg", keys: oCriteria.populations },
				{ field: "OrgehDiv", keys: oCriteria.divisions },
				{ field: "OrgehUnit", keys: oCriteria.units }
			].forEach(function (oPart) {
				if (oPart.keys.length) {
					aTerms.push("(" + oPart.keys.map(function (sKey) {
						return oPart.field + " eq '" + sKey + "'";
					}).join(" or ") + ")");
				}
			});

			return aTerms.join(" and ");
		},

		/**
		 * Recomputes isManager from the flat data and reconciles it with the
		 * backend flag. A row is a manager iff at least one other row points at it
		 * via managerId. The derived value wins - it drives the hierarchy sort and
		 * the bold employee name.
		 *
		 * @param {object[]} aFlat flat employee rows (mutated in place)
		 * @returns {object[]} the same array
		 */
		_deriveIsManager: function (aFlat) {
			var oHasChildren = {};

			aFlat.forEach(function (oRow) {
				if (oRow.managerId) {
					oHasChildren[oRow.managerId] = true;
				}
			});

			aFlat.forEach(function (oRow) {
				var bDerived = !!oHasChildren[oRow.employeeId];
				if (oRow.isManager !== bDerived) {
					Log.warning("isManager mismatch for " + oRow.employeeNumber +
						" - backend: " + oRow.isManager + ", derived: " + bDerived,
						null, "AllEmployees");
				}
				oRow.isManager = bDerived;
			});

			return aFlat;
		},

		/**
		 * Distinct אוכלוסייה / אגף / יחידה option lists, taken from the data that
		 * actually arrived rather than from a hardcoded table, and everything
		 * selected on entry.
		 *
		 * @param {object[]} aFlat flat employee rows
		 */
		_buildFilterOptionsFromData: function (aFlat) {
			var oViewModel = this.getView().getModel("view");

			var fnDistinct = function (sKeyField, sTextField) {
				var oSeen = {};
				return aFlat.reduce(function (aOut, oRow) {
					var sKey = oRow[sKeyField];
					if (sKey && !oSeen[sKey]) {
						oSeen[sKey] = true;
						aOut.push({ key: sKey, text: oRow[sTextField] || sKey });
					}
					return aOut;
				}, []).sort(function (oA, oB) {
					return oA.text.localeCompare(oB.text, "he");
				});
			};

			MULTI_FILTERS.forEach(function (oFilter) {
				var aItems = fnDistinct(oFilter.keyField, oFilter.textField);
				oViewModel.setProperty(oFilter.path, aItems);

				// The JSON model updates the bound aggregation synchronously, so the
				// items exist by the time the keys are applied.
				var oControl = this.byId(oFilter.controlId);
				if (oControl) {
					oControl.setSelectedKeys(aItems.map(function (oItem) {
						return oItem.key;
					}));
				}
			}, this);

			this._syncSelectAllState();
		},

		/* ============================ filters & search ============================ */

		onSearch: function (oEvent) {
			this.getView().getModel("view")
				.setProperty("/viewState/searchTerm", oEvent.getSource().getValue());
			this._invalidateTreeCache();
			this._applyFiltersAndSort();
		},

		onFilterChange: function () {
			this._syncSelectAllState();
			this._invalidateTreeCache();
			this._applyFiltersAndSort();
		},

		/**
		 * סוג דוח picks *which* report is being read, not which of the loaded rows
		 * to show - so it re-enters the data-load path. Today that returns the same
		 * mock; once the OData read in _onRouteMatched is live it re-reads
		 * /EmployeeSet with the new ReportType in $filter.
		 */
		onReportTypeChange: function () {
			this._onRouteMatched();
		},

		/** Reads the current filter UI into a plain, model-free criteria object. */
		_readFilterCriteria: function () {
			var fnKeys = function (sId) {
				var oControl = this.byId(sId);
				return oControl ? oControl.getSelectedKeys() : [];
			}.bind(this);

			var oSearchField = this.byId("aeSearchField");

			return MULTI_FILTERS.reduce(function (oCriteria, oFilter) {
				oCriteria[oFilter.criteriaKey] = fnKeys(oFilter.controlId);
				return oCriteria;
			}, {
				search: ((oSearchField && oSearchField.getValue()) || "").trim().toLowerCase()
			});
		},

		/**
		 * Recomputes whatever the current mode needs. The tree is built here and
		 * only here - and only when hierarchy mode is actually active.
		 */
		_applyFiltersAndSort: function () {
			var oViewModel = this.getView().getModel("view");
			var aAll = oViewModel.getProperty("/employees") || [];
			var oCriteria = this._readFilterCriteria();
			var sSortMode = oViewModel.getProperty("/viewState/sortMode");
			var bTree = oViewModel.getProperty("/viewState/isHierarchy");

			if (bTree) {
				var sRoot = oViewModel.getProperty("/viewState/currentManagerId");
				var aTree = this._getTree(aAll, oCriteria, sSortMode, sRoot);
				var aNodes = this._flattenTree(aTree);

				oViewModel.setProperty("/treeEmployees", aTree);
				// the band above the table counts the direct reports on screen
				oViewModel.setProperty("/group/count", aTree.length);

				// Unfiltered, the tree opens COLLAPSED - managers advertise their
				// reports with an arrow and the user decides, either row by row or
				// with פתיחת כל השורות. Once a filter or a search has narrowed it,
				// the surviving branches ARE the answer, so they are opened all the
				// way down: a match three levels deep must not hide behind the
				// ancestors that were only kept to reach it.
				var bNarrowed = aNodes.length < aAll.length;

				this._bindTable(true, bNarrowed ? maxLevel(aNodes) + 1 : 0);

				// Keep the button pair honest about what is on screen. Rebinding
				// resets sap.ui.table's expand state, so this is also the reset that
				// puts פתיחת כל השורות back after a filter change. The length guard is
				// for a search that matches nothing: an empty table is not "expanded",
				// and offering to collapse it would be nonsense.
				oViewModel.setProperty("/viewState/allExpanded",
					bNarrowed && aNodes.length > 0);
			} else {
				var aFlat = this._sortFlat(this._filterFlat(aAll, oCriteria), sSortMode);

				oViewModel.setProperty("/flatEmployees", aFlat);
				oViewModel.setProperty("/group/count", aFlat.length);

				this._bindTable(false);
			}
		},

		/**
		 * Cached wrapper around _collectWithAncestors + _buildTree + _sortNodes.
		 * The cache is what keeps a mode toggle from re-deriving an identical tree;
		 * it is dropped whenever the data, the criteria or the sort mode change.
		 *
		 * @param {object[]} aAll      the full flat list
		 * @param {object}   oCriteria current search + filter criteria
		 * @param {string}   sSortMode "name" | "hierarchy"
		 * @param {string}   sRoot     the logged-in manager's id
		 * @returns {object[]} level-0 nodes
		 */
		_getTree: function (aAll, oCriteria, sSortMode, sRoot) {
			var sKey = JSON.stringify([oCriteria, sSortMode, sRoot, aAll.length]);
			if (this._oTreeCache && this._oTreeCache.key === sKey) {
				return this._oTreeCache.tree;
			}

			var aTree = this._sortNodes(
				this._buildTree(this._collectWithAncestors(aAll, oCriteria), sRoot),
				sSortMode
			);

			this._oTreeCache = { key: sKey, tree: aTree };
			return aTree;
		},

		_invalidateTreeCache: function () {
			this._oTreeCache = null;
		},

		/**
		 * Plain filter, no ancestor logic. Returns a new array of the SAME row
		 * objects - nothing is copied and nothing is mutated.
		 *
		 * @param {object[]} aFlat     flat employee rows
		 * @param {object}   oCriteria search + filter criteria
		 * @returns {object[]} the matching rows
		 */
		_filterFlat: function (aFlat, oCriteria) {
			return (aFlat || []).filter(function (oRow) {
				return matchesCriteria(oRow, oCriteria);
			});
		},

		/**
		 * Parent-preserving filter for tree mode: every match keeps its whole
		 * ancestor chain, so a matching subordinate stays reachable under managers
		 * that do not match themselves.
		 *
		 * @param {object[]} aFlat     flat employee rows
		 * @param {object}   oCriteria search + filter criteria
		 * @returns {object[]} matches plus their ancestors, in input order
		 */
		_collectWithAncestors: function (aFlat, oCriteria) {
			var aRows = aFlat || [];
			var oById = indexById(aRows);
			var oKeep = {};

			aRows.forEach(function (oRow) {
				if (!matchesCriteria(oRow, oCriteria)) {
					return;
				}
				// walk up; oSeen also stops a cyclic managerId chain
				var oSeen = {};
				var oCurrent = oRow;
				while (oCurrent && !oSeen[oCurrent.employeeId]) {
					oSeen[oCurrent.employeeId] = true;
					oKeep[oCurrent.employeeId] = true;
					oCurrent = oCurrent.managerId ? oById[oCurrent.managerId] : null;
				}
			});

			return aRows.filter(function (oRow) {
				return oKeep[oRow.employeeId];
			});
		},

		/* ========================== mode & sort toggles ========================== */

		onToggleHierarchy: function (oEvent) {
			this.getView().getModel("view")
				.setProperty("/viewState/isHierarchy", oEvent.getParameter("pressed"));
			this._applyFiltersAndSort();
		},

		onToggleSort: function (oEvent) {
			var oItem = oEvent.getParameter("item");
			var sMode = oItem && oItem.data("sortMode");
			if (!sMode) {
				return;
			}

			this.getView().getModel("view").setProperty("/viewState/sortMode", sMode);
			this._invalidateTreeCache();
			this._applyFiltersAndSort();
		},

		/**
		 * Points the TreeTable's rows at the model path the current mode needs.
		 * Rebinding is skipped when the path is unchanged, so typing in the search
		 * field refreshes the data without tearing the binding down.
		 *
		 * @param {boolean} bHierarchy     true for tree mode
		 * @param {int}     [iExpandLevel] how deep to open the tree (tree mode only).
		 *                                 0 - or omitted - leaves it fully collapsed.
		 */
		_bindTable: function (bHierarchy, iExpandLevel) {
			var oTable = this.byId("employeesTable");
			if (!oTable) {
				return;
			}

			var sPath = bHierarchy ? "view>/treeEmployees" : "view>/flatEmployees";

			if (this._sBoundPath !== sPath) {
				this._sBoundPath = sPath;
				oTable.bindRows({
					path: sPath,
					// only `children` nests; every other array-valued property (there
					// are none today) stays a plain value rather than a child list
					parameters: { arrayNames: ["children"] }
				});
			}

			if (bHierarchy && oTable.getBinding("rows")) {
				// a data change resets the client tree binding's expand state, so the
				// wanted depth is re-applied explicitly rather than only at bind time.
				// expandToLevel(0) is not "collapse", so that case goes to collapseAll.
				if (iExpandLevel > 0) {
					oTable.expandToLevel(iExpandLevel);
				} else {
					oTable.collapseAll();
				}
			}
		},

		/**
		 * Sorts siblings at every level, recursively.
		 * Pure: no view access, and it only touches the nodes handed to it (which
		 * are _buildTree's clones, never /employees).
		 *
		 * @param {object[]} aNodes nested nodes
		 * @param {string}   sMode  "name" | "hierarchy"
		 * @returns {object[]} the same array, sorted
		 */
		_sortNodes: function (aNodes, sMode) {
			var fnCompare = getComparator(sMode);

			(function sortLevel(aLevel) {
				aLevel.sort(fnCompare);
				aLevel.forEach(function (oNode) {
					if (Array.isArray(oNode.children) && oNode.children.length) {
						sortLevel(oNode.children);
					}
				});
			})(aNodes || []);

			return aNodes;
		},

		/**
		 * Flat-mode sort. Returns a new array so the caller's input - and by
		 * extension /employees - keeps its original order.
		 *
		 * @param {object[]} aFlat flat employee rows
		 * @param {string}   sMode "name" | "hierarchy"
		 * @returns {object[]} a sorted copy
		 */
		_sortFlat: function (aFlat, sMode) {
			return (aFlat || []).slice().sort(getComparator(sMode));
		},

		/**
		 * Converts the flat employee list into the nested structure required by
		 * sap.ui.table.TreeTable (arrayNames: ["children"]).
		 * Pure function - no access to this.getView().
		 *
		 * @param {object[]} aFlat          flat rows, each with employeeId + managerId
		 * @param {string}   sRootManagerId managerId whose direct reports form level 0
		 * @returns {object[]} level-0 nodes, each with a children array
		 */
		_buildTree: function (aFlat, sRootManagerId) {
			var aRows = aFlat || [];
			var oById = {};
			var oSourceById = indexById(aRows);
			var aRoots = [];

			Log.debug("_buildTree over " + aRows.length + " rows", null, "AllEmployees");

			// 1st pass - clone each row and give it an empty children array.
			// Cloning is mandatory: never attach "children" onto /employees itself.
			aRows.forEach(function (oRow) {
				oById[oRow.employeeId] = Object.assign({}, oRow, {
					children: [],
					level: 0
				});
			});

			// 2nd pass - attach each node to its parent, or to the root list.
			aRows.forEach(function (oRow) {
				var oNode = oById[oRow.employeeId];
				var oParent = oById[oRow.managerId];

				if (oRow.managerId === oRow.employeeId) {
					Log.warning("employee " + oRow.employeeNumber +
						" is its own manager - treated as a root", null, "AllEmployees");
					aRoots.push(oNode);
				} else if (oRow.managerId === sRootManagerId || !oParent) {
					// direct report of the logged-in manager, or an orphan whose
					// parent was filtered out -> promote to level 0
					aRoots.push(oNode);
				} else if (isInManagerCycle(oRow, oSourceById)) {
					Log.warning("cyclic manager chain at " + oRow.employeeNumber +
						" - treated as a root", null, "AllEmployees");
					aRoots.push(oNode);
				} else {
					oParent.children.push(oNode);
				}
			});

			// 3rd pass - assign real depth and drop empty children arrays so the
			// TreeTable renders no expand arrow on leaf nodes.
			(function setLevel(aNodes, iLevel) {
				aNodes.forEach(function (oNode) {
					oNode.level = iLevel;
					if (oNode.children.length) {
						setLevel(oNode.children, iLevel + 1);
					} else {
						delete oNode.children;
					}
				});
			})(aRoots, 0);

			return aRoots;
		},

		/**
		 * Depth-first flattening of a nested tree, used for the Excel export so a
		 * collapsed branch still reaches the file.
		 *
		 * @param {object[]} aNodes nested nodes
		 * @param {object[]} [aOut] accumulator
		 * @returns {object[]} the nodes in display order
		 */
		_flattenTree: function (aNodes, aOut) {
			var aResult = aOut || [];

			(aNodes || []).forEach(function (oNode) {
				aResult.push(oNode);
				if (Array.isArray(oNode.children) && oNode.children.length) {
					this._flattenTree(oNode.children, aResult);
				}
			}, this);

			return aResult;
		},

		/* ============================== row actions ============================== */

		/**
		 * Pressing the employee's name opens that employee's card. There is no
		 * separate row-action button any more - the name in colEmployeeName is the
		 * only navigation trigger.
		 *
		 * @param {sap.ui.base.Event} oEvent press event of the name Link
		 */
		onNavigateToEmployee: function (oEvent) {
			var oRow = oEvent.getSource().getBindingContext("view").getObject();

			// TODO: wire up once the employee detail screen exists:
			// this.getOwnerComponent().getRouter().navTo("employeeDetail", {
			//     employeeId: oRow.employeeId
			// });
			MessageToast.show(this._getText("aeOpenEmployeePlaceholder", [
				oRow.employeeName, oRow.employeeNumber
			]));
		},

		/**
		 * Pressing the היעדרויות icon leaves for that employee's absences screen.
		 *
		 * @param {sap.ui.base.Event} oEvent press event of the icon Button
		 */
		onOpenAbsences: function (oEvent) {
			// TODO: wire up once the absences screen exists:
			// this.getOwnerComponent().getRouter().navTo("employeeAbsences", {
			//     employeeId: oRow.employeeId
			// });
			this._toastRowAction(oEvent, "aeOpenAbsencesPlaceholder");
		},

		/**
		 * Pressing the השתלמויות icon leaves for that employee's training screen.
		 *
		 * @param {sap.ui.base.Event} oEvent press event of the icon Button
		 */
		onOpenTraining: function (oEvent) {
			// TODO: wire up once the training screen exists:
			// this.getOwnerComponent().getRouter().navTo("employeeTraining", {
			//     employeeId: oRow.employeeId
			// });
			this._toastRowAction(oEvent, "aeOpenTrainingPlaceholder");
		},

		/**
		 * Placeholder for the row-action icons until their screens exist: names the
		 * employee whose row was pressed, so it is visible that the press reached the
		 * right record and not just the right column.
		 *
		 * @param {sap.ui.base.Event} oEvent press event of a row-action Button
		 * @param {string}            sKey   i18n key taking name + number
		 */
		_toastRowAction: function (oEvent, sKey) {
			var oRow = oEvent.getSource().getBindingContext("view").getObject();
			MessageToast.show(this._getText(sKey, [
				oRow.employeeName, oRow.employeeNumber
			]));
		},

		// Per-row expand / collapse needs no handler of its own: the TreeTable's
		// own tree icon owns that interaction, and a press handler layered on top
		// would re-toggle whatever the control had just done. The two toolbar
		// buttons below are different - they act on the whole tree at once.

		/* ============================ toolbar actions ============================ */

		/**
		 * פתיחת כל השורות. expandToLevel wants an absolute depth, so the tree's own
		 * depth is measured rather than passing some arbitrarily large number.
		 *
		 * Flips /viewState/allExpanded, which swaps this button out for צמצום כל
		 * השורות - the two are one control in two states, never both on screen.
		 *
		 * Not persistent by design: a filter, a search or a sort rebuilds the tree
		 * and sap.ui.table resets the expand state, so _applyFiltersAndSort resets
		 * the flag with it.
		 */
		onExpandAll: function () {
			var oTable = this.byId("employeesTable");
			var oViewModel = this.getView().getModel("view");

			if (!oTable || !oViewModel.getProperty("/viewState/isHierarchy")) {
				return;
			}

			var aNodes = this._flattenTree(oViewModel.getProperty("/treeEmployees"));
			oTable.expandToLevel(maxLevel(aNodes) + 1);
			oViewModel.setProperty("/viewState/allExpanded", true);
		},

		/** צמצום כל השורות - back to the level-0 rows, and back to the other button. */
		onCollapseAll: function () {
			var oTable = this.byId("employeesTable");
			var oViewModel = this.getView().getModel("view");

			if (!oTable || !oViewModel.getProperty("/viewState/isHierarchy")) {
				return;
			}

			oTable.collapseAll();
			oViewModel.setProperty("/viewState/allExpanded", false);
		},

		onOpenViewSettings: function () {
			if (!this._pViewSettingsDialog) {
				this._pViewSettingsDialog = Fragment.load({
					id: this.getView().getId(),
					name: "modtimesheet.view.AllEmployeesViewSettings",
					controller: this
				}).then(function (oDialog) {
					this.getView().addDependent(oDialog);
					return oDialog;
				}.bind(this));
			}

			this._pViewSettingsDialog.then(function (oDialog) {
				oDialog.open();
			});
		},

		onCloseViewSettings: function () {
			this._pViewSettingsDialog.then(function (oDialog) {
				oDialog.close();
			});
		},

		/** Mirrors /viewSettings/columns onto the table's column visibility. */
		onColumnVisibilityChange: function () {
			(this.getView().getModel("view").getProperty("/viewSettings/columns") || [])
				.forEach(function (oCol) {
					var oColumn = this.byId(oCol.columnId);
					if (oColumn) {
						oColumn.setVisible(oCol.visible);
					}
				}, this);
		},

		onExportToExcel: function () {
			var aRows = this._getExportRows();

			// Same order as the table's columns. colAbsences is absent on purpose:
			// it holds an action, not a value.
			var aColumns = [
				{ label: this._getText("aeColEmployeeName"), property: "employeeName" },
				{ label: this._getText("aeColDirectManager"), property: "managerName" },
				{ label: this._getText("aeColEmployeeNumber"), property: "employeeNumber" },
				{ label: this._getText("aeColPopulation"), property: "populationText" },
				{ label: this._getText("aeColDivision"), property: "divisionName" },
				{ label: this._getText("aeColUnit"), property: "unitName" }
			];

			var sFileName = this._getText("aeExportFileName") + ".xlsx";

			sap.ui.require(["sap/ui/export/Spreadsheet"], function (Spreadsheet) {
				var oSheet = new Spreadsheet({
					workbook: { columns: aColumns },
					dataSource: { type: "json", data: aRows },
					fileName: sFileName
				});
				oSheet.build().finally(function () {
					oSheet.destroy();
				});
			});
		},

		/**
		 * The rows the export should contain: everything that survived the current
		 * filter and search, in the current sort order. In tree mode the nested
		 * result is flattened depth-first, so a collapsed branch is exported too.
		 *
		 * @returns {object[]} rows for the spreadsheet
		 */
		_getExportRows: function () {
			var oViewModel = this.getView().getModel("view");

			if (oViewModel.getProperty("/viewState/isHierarchy")) {
				return this._flattenTree(oViewModel.getProperty("/treeEmployees"));
			}
			return (oViewModel.getProperty("/flatEmployees") || []).slice();
		},

		/**
		 * Print. The @media print block in css/style.css drops the page header, the
		 * toolbar and the row-action column, leaving the table on the page.
		 */
		onPrint: function () {
			window.print();
		},

		/* ================================ helpers ================================ */

		/**
		 * All three multi-selects start with every option checked, which UI5 would
		 * render as a row of tokens inside a 44px pill. `aeAllSelected` collapses
		 * that back to the field's "הכל" placeholder while the selection is
		 * complete, and lifts as soon as the user narrows it down.
		 */
		_syncSelectAllState: function () {
			MULTI_FILTERS.forEach(function (oFilter) {
				var oControl = this.byId(oFilter.controlId);
				if (!oControl) {
					return;
				}
				var iItems = oControl.getItems().length;
				var bAll = iItems > 0 && oControl.getSelectedKeys().length === iItems;
				oControl.toggleStyleClass("aeAllSelected", bAll);
			}, this);
		},

		/**
		 * @param {string}   sKey    i18n key
		 * @param {any[]}    [aArgs] placeholder values
		 * @returns {string} the translated text
		 */
		_getText: function (sKey, aArgs) {
			return this.getOwnerComponent().getModel("i18n")
				.getResourceBundle().getText(sKey, aArgs);
		}
	});
});
