/* global QUnit */
sap.ui.define([
	"sap/ui/model/json/JSONModel",
	"modtimesheet/controller/AllEmployees.controller",
	"modtimesheet/model/formatter",
	"modtimesheet/model/mockEmployees"
], function (JSONModel, AllEmployeesController, formatter, mockEmployees) {
	"use strict";

	var ROOT = "M0000001";

	/**
	 * A controller wired to a JSON model but with no view behind it. Every helper
	 * under test is either pure or only touches the "view" model, so byId() can
	 * safely answer null - _readFilterCriteria then reports "no restriction" and
	 * _bindTable becomes a no-op.
	 */
	function makeController(aFlat) {
		var oController = new AllEmployeesController();
		var oModel = new JSONModel({
			viewState: {
				isHierarchy: false,
				sortMode: "name",
				busy: false,
				searchTerm: "",
				reportType: "ATTENDANCE",
				currentManagerId: ROOT
			},
			filters: { reportTypes: [], populations: [], divisions: [], units: [] },
			group: { text: "", count: 0 },
			employees: aFlat || [],
			flatEmployees: [],
			treeEmployees: [],
			suggestions: []
		});

		// mirrors onInit: the switch starts off, so the default here is also the
		// screen's default - inactive employees are gated out
		oModel.setProperty("/viewState/showInactive", false);

		oController.getView = function () {
			return { getModel: function () { return oModel; } };
		};
		oController.byId = function () { return null; };
		// there is no component behind the controller, so the resource bundle is
		// stubbed with the key itself - enough to assert *that* a text was used
		oController._getText = function (sKey) { return "{" + sKey + "}"; };
		oController._invalidateTreeCache();

		return oController;
	}

	/**
	 * The mock list minus its leavers - what the screen shows while the
	 * הצגת עובדים לא פעילים switch is off, and therefore the baseline most
	 * assertions below are measured against.
	 */
	function activeOnly(aFlat) {
		return aFlat.filter(function (oRow) {
			return oRow.isActive !== false;
		});
	}

	/** A stand-in for the SearchField's suggest event. */
	function suggestEvent(sValue) {
		return {
			getParameter: function (sName) {
				return sName === "suggestValue" ? sValue : undefined;
			}
		};
	}

	/** [number, name, isManager, managerId] -> a minimal flat row. */
	function row(sNumber, sName, bManager, sManagerId) {
		return {
			employeeId: "E" + sNumber,
			employeeNumber: sNumber,
			employeeName: sName,
			isManager: bManager,
			managerId: sManagerId,
			managerName: "",
			populationKey: "MOD",
			populationText: "עובד/ת משהב\"ט",
			divisionKey: "D01",
			divisionName: "אגף א",
			unitKey: "U01",
			unitName: "יחידה א"
		};
	}

	function byId(aNodes, sId) {
		var oFound = null;
		(function walk(aLevel) {
			aLevel.forEach(function (oNode) {
				if (oNode.employeeId === sId) {
					oFound = oNode;
				}
				if (oNode.children) {
					walk(oNode.children);
				}
			});
		})(aNodes);
		return oFound;
	}

	/* ========================================================================
	   _buildTree
	   ===================================================================== */

	QUnit.module("AllEmployees - _buildTree");

	QUnit.test("nests the flat list under the logged-in manager", function (assert) {
		var oController = makeController();
		var aFlat = mockEmployees.getFlat();
		oController._deriveIsManager(aFlat);

		var aTree = oController._buildTree(aFlat, ROOT);

		assert.strictEqual(aTree.length, 9, "nine direct reports become level 0");

		var oAviram = byId(aTree, "E2251424");
		assert.strictEqual(oAviram.level, 0, "אבירם כהן sits at level 0");
		assert.strictEqual(oAviram.children.length, 3, "and has three subordinates");

		var oRoei = byId(aTree, "E2251568");
		assert.strictEqual(oRoei.level, 1, "רועי בן חמו is one level down");
		assert.strictEqual(oRoei.children.length, 2, "and is himself a manager");

		var oShahar = byId(aTree, "E2251613");
		assert.strictEqual(oShahar.level, 2, "his reports reach level 2 - four levels in all");
	});

	QUnit.test("leaves carry no children key, so no expand arrow is drawn", function (assert) {
		var oController = makeController();
		var aTree = oController._buildTree(mockEmployees.getFlat(), ROOT);

		var oLeaf = byId(aTree, "E2251613");
		assert.notOk(oLeaf.hasOwnProperty("children"), "leaf has no children property");

		var oManager = byId(aTree, "E2251424");
		assert.ok(Array.isArray(oManager.children), "a manager keeps its children array");
	});

	QUnit.test("never mutates the source rows", function (assert) {
		var oController = makeController();
		var aFlat = mockEmployees.getFlat();
		var sBefore = JSON.stringify(aFlat);

		oController._buildTree(aFlat, ROOT);

		assert.strictEqual(JSON.stringify(aFlat), sBefore, "the flat array is byte-identical");
		assert.notOk(aFlat.some(function (oRow) {
			return oRow.hasOwnProperty("children") || oRow.hasOwnProperty("level");
		}), "no children/level keys leaked into the source");
	});

	QUnit.test("promotes an orphan whose manager was filtered out", function (assert) {
		var oController = makeController();
		// the manager (E2) is absent from the list handed in
		var aFlat = [
			row("1", "אבי", false, ROOT),
			row("3", "גלי", false, "E2")
		];

		var aTree = oController._buildTree(aFlat, ROOT);

		assert.strictEqual(aTree.length, 2, "both rows end up at level 0");
		assert.strictEqual(byId(aTree, "E3").level, 0, "the orphan is promoted, not dropped");
	});

	QUnit.test("survives a cyclic manager chain", function (assert) {
		var oController = makeController();
		var aFlat = [
			row("1", "אבי", true, "E2"),
			row("2", "בני", true, "E1"),
			row("3", "גלי", false, ROOT)
		];

		var aTree = oController._buildTree(aFlat, ROOT);

		assert.strictEqual(aTree.length, 3, "the cycle's members are broken out as roots");
		assert.strictEqual(byId(aTree, "E1").level, 0, "no infinite recursion while levelling");
	});

	QUnit.test("treats a self-referencing row as a root", function (assert) {
		var oController = makeController();
		var aFlat = [row("1", "אבי", false, "E1")];

		var aTree = oController._buildTree(aFlat, ROOT);

		assert.strictEqual(aTree.length, 1, "one root");
		assert.notOk(aTree[0].hasOwnProperty("children"), "and it is not its own child");
	});

	QUnit.test("is deterministic", function (assert) {
		var oController = makeController();

		assert.strictEqual(
			JSON.stringify(oController._buildTree(mockEmployees.getFlat(), ROOT)),
			JSON.stringify(oController._buildTree(mockEmployees.getFlat(), ROOT)),
			"two runs over the same input agree");
	});

	/* ========================================================================
	   _deriveIsManager
	   ===================================================================== */

	QUnit.module("AllEmployees - _deriveIsManager");

	QUnit.test("reconciles the backend flag against the actual child count", function (assert) {
		var oController = makeController();
		var aFlat = [
			// claims to be a manager but nobody reports to them
			row("1", "אבי", true, ROOT),
			// claims not to be, yet has a report
			row("2", "בני", false, ROOT),
			row("3", "גלי", false, "E2")
		];

		oController._deriveIsManager(aFlat);

		assert.strictEqual(aFlat[0].isManager, false, "false positive corrected");
		assert.strictEqual(aFlat[1].isManager, true, "false negative corrected");
		assert.strictEqual(aFlat[2].isManager, false, "a leaf stays a leaf");
	});

	QUnit.test("agrees with the mock's own flags", function (assert) {
		var aFlat = mockEmployees.getFlat();
		var aClaimed = aFlat.map(function (oRow) { return oRow.isManager; });

		makeController()._deriveIsManager(aFlat);

		assert.deepEqual(aFlat.map(function (oRow) { return oRow.isManager; }), aClaimed,
			"the mock dataset is internally consistent");
	});

	/* ========================================================================
	   sorting
	   ===================================================================== */

	QUnit.module("AllEmployees - sorting");

	/** Walks every sibling group and hands it to fnCheck. */
	function eachLevel(aNodes, fnCheck) {
		fnCheck(aNodes);
		aNodes.forEach(function (oNode) {
			if (oNode.children && oNode.children.length) {
				eachLevel(oNode.children, fnCheck);
			}
		});
	}

	QUnit.test("sortMode 'name' orders every level alphabetically", function (assert) {
		var oController = makeController();
		var aFlat = mockEmployees.getFlat();
		oController._deriveIsManager(aFlat);

		var aTree = oController._sortNodes(oController._buildTree(aFlat, ROOT), "name");

		eachLevel(aTree, function (aLevel) {
			var aNames = aLevel.map(function (oNode) { return oNode.employeeName; });
			var aExpected = aNames.slice().sort(function (a, b) {
				return a.localeCompare(b, "he");
			});
			assert.deepEqual(aNames, aExpected, "level of " + aNames.length + " is alphabetical");
		});
	});

	QUnit.test("sortMode 'hierarchy' puts managers first at every level", function (assert) {
		var oController = makeController();
		var aFlat = mockEmployees.getFlat();
		oController._deriveIsManager(aFlat);

		var aTree = oController._sortNodes(oController._buildTree(aFlat, ROOT), "hierarchy");

		eachLevel(aTree, function (aLevel) {
			var bSeenEmployee = false;
			var aManagers = [];
			var aEmployees = [];

			aLevel.forEach(function (oNode) {
				if (oNode.isManager) {
					assert.notOk(bSeenEmployee,
						oNode.employeeName + " (manager) precedes every non-manager");
					aManagers.push(oNode.employeeName);
				} else {
					bSeenEmployee = true;
					aEmployees.push(oNode.employeeName);
				}
			});

			[aManagers, aEmployees].forEach(function (aBlock) {
				assert.deepEqual(aBlock, aBlock.slice().sort(function (a, b) {
					return a.localeCompare(b, "he");
				}), "the block is alphabetical within itself");
			});
		});
	});

	QUnit.test("_sortFlat copies rather than sorting the caller's array", function (assert) {
		var oController = makeController();
		var aFlat = [row("1", "גלי", false, ROOT), row("2", "אבי", false, ROOT)];
		var aOriginalOrder = aFlat.map(function (oRow) { return oRow.employeeName; });

		var aSorted = oController._sortFlat(aFlat, "name");

		assert.deepEqual(aSorted.map(function (oRow) { return oRow.employeeName; }),
			["אבי", "גלי"], "the copy is sorted");
		assert.deepEqual(aFlat.map(function (oRow) { return oRow.employeeName; }),
			aOriginalOrder, "the input keeps its order");
	});

	QUnit.test("_sortFlat 'hierarchy' orders managers first across the whole list", function (assert) {
		var oController = makeController();
		var aFlat = [
			row("1", "גלי", false, ROOT),
			row("2", "אבי", false, ROOT),
			row("3", "רון", true, ROOT),
			row("4", "בני", true, ROOT)
		];

		assert.deepEqual(
			oController._sortFlat(aFlat, "hierarchy").map(function (oRow) { return oRow.employeeName; }),
			["בני", "רון", "אבי", "גלי"],
			"managers alphabetically, then everyone else alphabetically");
	});

	/* ========================================================================
	   filtering
	   ===================================================================== */

	QUnit.module("AllEmployees - filtering");

	QUnit.test("_filterFlat matches name, number and direct manager", function (assert) {
		var oController = makeController();
		var aFlat = mockEmployees.getFlat();

		assert.strictEqual(oController._filterFlat(aFlat, { search: "2251613" }).length, 1,
			"מספר עובד matches");
		assert.strictEqual(oController._filterFlat(aFlat, { search: "שחר" }).length, 1,
			"שם עובד matches");
		assert.strictEqual(oController._filterFlat(aFlat, { search: "רועי בן חמו" }).length, 3,
			"מנהל ישיר matches - the manager's own row plus their two reports");
	});

	QUnit.test("_filterFlat honours the multi-select keys", function (assert) {
		var oController = makeController();
		var aFlat = mockEmployees.getFlat();

		assert.strictEqual(oController._filterFlat(aFlat, { divisions: [] }).length, aFlat.length,
			"an empty key list is no restriction");
		assert.ok(oController._filterFlat(aFlat, { populations: ["SOLDIER"] }).every(function (oRow) {
			return oRow.populationKey === "SOLDIER";
		}), "only the selected אוכלוסייה survives");
	});

	QUnit.test("_collectWithAncestors keeps a match's whole ancestor chain", function (assert) {
		var oController = makeController();
		var aFlat = mockEmployees.getFlat();

		// שחר גולן sits three levels down: אבירם כהן -> רועי בן חמו -> שחר גולן
		var aKept = oController._collectWithAncestors(aFlat, { search: "שחר גולן" });
		var aIds = aKept.map(function (oRow) { return oRow.employeeId; });

		assert.deepEqual(aIds.sort(), ["E2251424", "E2251568", "E2251613"].sort(),
			"the match and both ancestors are kept, nothing else");
	});

	QUnit.test("_collectWithAncestors returns nothing when nothing matches", function (assert) {
		var oController = makeController();

		assert.deepEqual(
			oController._collectWithAncestors(mockEmployees.getFlat(), { search: "zzzz" }),
			[], "no match, no ancestors");
	});

	/* ========================================================================
	   mode handling
	   ===================================================================== */

	QUnit.module("AllEmployees - mode handling");

	QUnit.test("flat mode never builds the tree", function (assert) {
		var aFlat = mockEmployees.getFlat();
		var oController = makeController(aFlat);
		var iCalls = 0;
		var fnOriginal = oController._buildTree;

		oController._buildTree = function () {
			iCalls++;
			return fnOriginal.apply(this, arguments);
		};

		oController._applyFiltersAndSort();
		assert.strictEqual(iCalls, 0, "_buildTree is not invoked in flat mode");
		assert.strictEqual(
			oController.getView().getModel("view").getProperty("/flatEmployees").length,
			activeOnly(aFlat).length, "every listed row is bound instead");

		oController.getView().getModel("view").setProperty("/viewState/isHierarchy", true);
		oController._applyFiltersAndSort();
		assert.strictEqual(iCalls, 1, "and exactly once after switching to tree mode");
	});

	QUnit.test("/employees is untouched by mode and sort changes", function (assert) {
		var oController = makeController(mockEmployees.getFlat());
		var oModel = oController.getView().getModel("view");
		var sBefore = JSON.stringify(oModel.getProperty("/employees"));

		["name", "hierarchy"].forEach(function (sSortMode) {
			[false, true].forEach(function (bHierarchy) {
				oModel.setProperty("/viewState/sortMode", sSortMode);
				oModel.setProperty("/viewState/isHierarchy", bHierarchy);
				oController._invalidateTreeCache();
				oController._applyFiltersAndSort();
			});
		});

		assert.strictEqual(JSON.stringify(oModel.getProperty("/employees")), sBefore,
			"the source of truth survived every toggle unchanged");
	});

	QUnit.test("the group count follows the current mode and filter", function (assert) {
		var oController = makeController(mockEmployees.getFlat());
		var oModel = oController.getView().getModel("view");

		oController._applyFiltersAndSort();
		assert.strictEqual(oModel.getProperty("/group/count"), 16,
			"flat mode counts every listed row - the three leavers are gated out");

		oModel.setProperty("/viewState/isHierarchy", true);
		oController._applyFiltersAndSort();
		assert.strictEqual(oModel.getProperty("/group/count"), 8,
			"tree mode counts the direct reports below the band - one of the nine has left");

		oModel.setProperty("/viewState/showInactive", true);
		oController._invalidateTreeCache();
		oController._applyFiltersAndSort();
		assert.strictEqual(oModel.getProperty("/group/count"), 9,
			"the switch adds דנה מזרחי back as a ninth direct report");

		oModel.setProperty("/viewState/isHierarchy", false);
		oController._applyFiltersAndSort();
		assert.strictEqual(oModel.getProperty("/group/count"), 19,
			"and the flat list is the whole dataset again");
	});

	/* ========================================================================
	   הצגת עובדים לא פעילים - the gate, and the suggestion list it governs
	   ===================================================================== */

	QUnit.module("AllEmployees - inactive employees");

	QUnit.test("_filterByActive hides leavers unless the switch is on", function (assert) {
		var oController = makeController();
		var aFlat = mockEmployees.getFlat();

		assert.strictEqual(oController._filterByActive(aFlat, false).length, 16,
			"three of the nineteen have left");
		assert.ok(oController._filterByActive(aFlat, false).every(function (oRow) {
			return oRow.isActive !== false;
		}), "and none of them survives the gate");
		assert.strictEqual(oController._filterByActive(aFlat, true).length, aFlat.length,
			"switched on, the gate is open");
	});

	QUnit.test("a row with no isActive flag counts as active", function (assert) {
		var oController = makeController();
		var oRow = row("1", "אבי", false, ROOT);

		assert.strictEqual(oController._filterByActive([oRow], false).length, 1,
			"a service that stops sending the field must not empty the screen");
	});

	QUnit.test("an inactive employee cannot come back as an ancestor", function (assert) {
		// The gate runs before the tree is built. Were it just another criterion,
		// _collectWithAncestors would keep this manager to reach its active report.
		var oManager = row("1", "מנהל שסיים", true, ROOT);
		oManager.isActive = false;
		var oReport = row("2", "עובד פעיל", false, "E1");

		var oController = makeController([oManager, oReport]);
		var oModel = oController.getView().getModel("view");
		oModel.setProperty("/viewState/isHierarchy", true);
		oController._applyFiltersAndSort();

		var aTree = oModel.getProperty("/treeEmployees");
		assert.strictEqual(aTree.length, 1, "one row on screen");
		assert.strictEqual(aTree[0].employeeId, "E2",
			"the active report, promoted to level 0 in place of its gated manager");
	});

	QUnit.test("onSuggest matches name and number, and caps the list", function (assert) {
		var oController = makeController(mockEmployees.getFlat());
		var oModel = oController.getView().getModel("view");

		oController.onSuggest(suggestEvent("שחר"));
		assert.deepEqual(
			oModel.getProperty("/suggestions").map(function (oItem) { return oItem.text; }),
			["שחר גולן 2251613"],
			"the name matches, and the entry carries name + number");

		oController.onSuggest(suggestEvent("2251613"));
		assert.strictEqual(oModel.getProperty("/suggestions").length, 1, "so does the number");

		oController.onSuggest(suggestEvent("225"));
		assert.strictEqual(oModel.getProperty("/suggestions").length, 8,
			"a term that matches everyone is capped at MAX_SUGGESTIONS");

		oController.onSuggest(suggestEvent("   "));
		assert.deepEqual(oModel.getProperty("/suggestions"), [],
			"an empty term offers nothing, rather than the whole list");
	});

	QUnit.test("a leaver is suggested only once the switch is on, and marked", function (assert) {
		var oController = makeController(mockEmployees.getFlat());
		var oModel = oController.getView().getModel("view");

		// דנה מזרחי is one of the three leavers in the mock
		oController.onSuggest(suggestEvent("דנה"));
		assert.deepEqual(oModel.getProperty("/suggestions"), [],
			"switch off: the search cannot even offer her - the point of the field order");

		oModel.setProperty("/viewState/showInactive", true);
		oController.onSuggest(suggestEvent("דנה"));

		var aItems = oModel.getProperty("/suggestions");
		assert.strictEqual(aItems.length, 1, "switch on: she is offered");
		assert.strictEqual(aItems[0].description, "{aeInactiveSuggestion}",
			"with the grey note that says so");
		assert.strictEqual(aItems[0].text.indexOf("{aeInactiveSuggestion}"), -1,
			"and the note stays out of the text that lands in the search field");
	});

	QUnit.test("an active employee is suggested without a note", function (assert) {
		var oController = makeController(mockEmployees.getFlat());

		oController.onSuggest(suggestEvent("שחר"));
		assert.strictEqual(
			oController.getView().getModel("view").getProperty("/suggestions")[0].description,
			"", "nothing to say about a current employee");
	});

	QUnit.test("a suggestion's text narrows the table to that one employee", function (assert) {
		var oController = makeController(mockEmployees.getFlat());
		var oModel = oController.getView().getModel("view");

		oController.onSuggest(suggestEvent("שחר"));
		var sPicked = oModel.getProperty("/suggestions")[0].text;

		// picking an entry writes its text straight into the search field, which is
		// what _readFilterCriteria then reads
		assert.strictEqual(
			oController._filterFlat(mockEmployees.getFlat(), {
				search: sPicked.toLowerCase()
			}).length,
			1, "\"" + sPicked + "\" resolves to a single row");
	});

	QUnit.test("onToggleInactive drops the stale suggestion list", function (assert) {
		var oController = makeController(mockEmployees.getFlat());
		var oModel = oController.getView().getModel("view");

		oController.onSuggest(suggestEvent("שחר"));
		assert.strictEqual(oModel.getProperty("/suggestions").length, 1, "a list is up");

		// the switch's own binding writes the state; the handler only recomputes
		oModel.setProperty("/viewState/showInactive", true);
		oController.onToggleInactive();

		assert.deepEqual(oModel.getProperty("/suggestions"), [],
			"it was built for the previous state of the switch, so it goes");
		assert.strictEqual(oModel.getProperty("/flatEmployees").length, 19,
			"and the table is recomputed with the leavers in");
	});

	/* ========================================================================
	   formatters
	   ===================================================================== */

	QUnit.module("AllEmployees - formatter");

	QUnit.test("countInParentheses", function (assert) {
		assert.strictEqual(formatter.countInParentheses(9), "(9)");
		assert.strictEqual(formatter.countInParentheses(0), "(0)");
		assert.strictEqual(formatter.countInParentheses(undefined), "", "no count, no parentheses");
	});

	// directManagerText / isManagerFlag are gone: שם מנהל ישיר binds managerName
	// straight through, and every employee name shares one weight.
});
