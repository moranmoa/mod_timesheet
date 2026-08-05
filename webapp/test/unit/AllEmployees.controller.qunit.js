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
			treeEmployees: []
		});

		oController.getView = function () {
			return { getModel: function () { return oModel; } };
		};
		oController.byId = function () { return null; };
		oController._invalidateTreeCache();

		return oController;
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
			aFlat.length, "every row is bound instead");

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
		assert.strictEqual(oModel.getProperty("/group/count"), 19,
			"flat mode counts every listed row");

		oModel.setProperty("/viewState/isHierarchy", true);
		oController._applyFiltersAndSort();
		assert.strictEqual(oModel.getProperty("/group/count"), 9,
			"tree mode counts the direct reports below the band");
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
