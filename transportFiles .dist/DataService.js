sap.ui.define([], function () {
	"use strict";

	/* =========================================================================
	 * DataService
	 * -------------------------------------------------------------------------
	 * This is the SINGLE place you plug in your real data source.
	 *
	 *   >>> Replace the body of `getManagerReports()` with your backend call. <<<
	 *
	 * The rest of the app (filtering / sorting / paging / export / status tabs)
	 * works purely against the array returned here - you do NOT need to touch
	 * the view or the controller. Just return an array of row objects with the
	 * shape documented below.
	 *
	 * Row shape expected by the screen:
	 * {
	 *   employeeName:       string,   // "שם עובד"        (column, searchable)
	 *   employeeNumber:     string,   // "מספר עובד"      (column, searchable)
	 *   population:         string,   // "אוכלוסייה"      (chip text)
	 *   populationKey:      string,   // filter key: MOD | EXTERNAL | SOLDIER | NATIONAL
	 *   branch:             string,   // "אנף"            (column + filter, searchable)
	 *   branchKey:          string,   // filter key for branch
	 *   unit:               string,   // "יחידה"          (column + filter)
	 *   unitKey:            string,   // filter key for unit
	 *   managerName:        string,   // "שם ממונה"       (column, searchable)
	 *   managerKey:         string,   // filter key for the "שם ממונה" filter
	 *   handledByKey:       string,   // "נמצא בטיפול": EMPLOYEE | MANAGER | HR | DELEGATION
	 *                                // ("" when nobody holds it, i.e. approved).
	 *                                // Must agree with `status`: the status tabs
	 *                                // and this filter are synced on screen.
	 *   isDirect:           bool,     // "כפיפים": true = direct report of the manager
	 *   approvalMonth:      string,   // "חודש לאישור"    e.g. "01/2025"
	 *   approvalMonthKey:   string,   // month filter key "1".."12"
	 *   approvalYearKey:    string,   // year filter key  "2021".."2025"
	 *   extraMonths:        int,      // >0 shows the "N+" badge next to the month
	 *   reportType:         string,   // filter key: ATTENDANCE | ABSENCE | TRAINING
	 *   status:             string,   // one of the STATUS.* keys below
	 *   processStep:        int,      // current step (shows "step/total")
	 *   processTotal:       int,      // total steps
	 *   stepStates:         [{state}] // per-dot: {state:"done"|"current"|"open"}
	 * }
	 * ========================================================================= */

	// Status keys - drive the four tabs at the top of the screen.
	var STATUS = {
		PENDING_EMPLOYEE: "PENDING_EMPLOYEE", // ממתין לעובד
		PENDING_MY_APPROVAL: "PENDING_MY_APPROVAL", // ממתין לאישורי
		PENDING_HR: "PENDING_HR", // ממתין למשא"ן
		APPROVED: "APPROVED" // אושרו
	};

	// ---- current user + role -------------------------------------------------
	// The logged-in user. Swap `role` to "HR" to see the משא"ן defaults kick in.
	// In a real deployment this comes from the backend / user service.
	var CURRENT_USER = {
		managerKey: "M1",
		managerName: "משה כהן",
		role: "MANAGER" // MANAGER | HR
	};

	// Role -> default status tab + default "נמצא בטיפול" (handling party) value.
	// A manager lands on "ממתין לאישורי"; a משא"ן user lands on "ממתין למשא"ן".
	var ROLE_DEFAULTS = {
		MANAGER: { statusTab: STATUS.PENDING_MY_APPROVAL, handledByKey: "MANAGER" },
		HR: { statusTab: STATUS.PENDING_HR, handledByKey: "HR" }
	};

	// Managers available in the "שם ממונה" filter. The current user is M1.
	var aManagers = [
		{ key: "M1", text: "משה כהן" },
		{ key: "M2", text: "דנה לוי" },
		{ key: "M3", text: "יוסי אברהם" }
	];
	var mManagerName = aManagers.reduce(function (o, m) { o[m.key] = m.text; return o; }, {});

	// "נמצא בטיפול" - who currently holds the report. "ALL" means no restriction.
	var aHandlingParties = [
		{ key: "EMPLOYEE", text: "עובד" },
		{ key: "MANAGER", text: "ממונה" },
		{ key: "HR", text: 'משא"ן' },
		{ key: "DELEGATION", text: "שליחות" },
		{ key: "ALL", text: "כל הגורמים המאשרים" }
	];

	// "כפיפים" - direct reports only vs. the whole subtree.
	var aSubordinateScopes = [
		{ key: "DIRECT", text: "ישירים בלבד" },
		{ key: "ALL", text: "כל הכפיפים" }
	];

	// ---- mock helpers -------------------------------------------------------
	var aBranches = [
		{ key: "B1", text: "מע נהולוני ובקש...ת" },
		{ key: "B2", text: "שם אנף שם אנף" }
	];
	var aUnits = [
		{ key: "U1", text: "שם יחידה שם יחידה" }
	];
	var aPopulations = [
		{ key: "MOD", text: "עובד משהב\"ט" },
		{ key: "EXTERNAL", text: "עובד חיצוני" },
		{ key: "SOLDIER", text: "חייל" },
		{ key: "NATIONAL", text: "שירות לאומי" }
	];
	var aStepTemplates = [
		["done", "current", "open"],
		["done", "done", "current"],
		["done", "done", "done"]
	];

	function _buildMockRows() {
		var aRows = [];
		var aStatusCycle = [
			STATUS.PENDING_MY_APPROVAL, STATUS.PENDING_HR, STATUS.PENDING_EMPLOYEE,
			STATUS.APPROVED, STATUS.PENDING_MY_APPROVAL, STATUS.PENDING_MY_APPROVAL,
			STATUS.PENDING_HR, STATUS.PENDING_EMPLOYEE
		];
		// Most rows belong to the current manager (M1) so the role-based defaults
		// still show a healthy set out of the box; the rest belong to other managers.
		var aManagerCycle = ["M1", "M1", "M2", "M1", "M3", "M1", "M1", "M2", "M1", "M3"];
		// "נמצא בטיפול" describes the same thing as the status tab - the party the
		// report waits on - so it is derived from the status rather than cycled
		// independently, otherwise the two (now synced) filters contradict each
		// other on screen. Approved reports wait on nobody.
		var mStatusToHandledBy = {};
		mStatusToHandledBy[STATUS.PENDING_EMPLOYEE] = "EMPLOYEE";
		mStatusToHandledBy[STATUS.PENDING_MY_APPROVAL] = "MANAGER";
		mStatusToHandledBy[STATUS.PENDING_HR] = "HR";
		mStatusToHandledBy[STATUS.APPROVED] = "";

		// Anchor most rows on the current year + month so the default filters
		// (current year + current month) show data out of the box.
		var oNow = new Date();
		var iCurYear = oNow.getFullYear();
		var iCurMonth = oNow.getMonth() + 1;

		for (var i = 0; i < 34; i++) {
			var oPop = aPopulations[i % aPopulations.length];
			var oBranch = aBranches[i % aBranches.length];
			var oUnit = aUnits[i % aUnits.length];
			var sStatus = aStatusCycle[i % aStatusCycle.length];
			var sManagerKey = aManagerCycle[i % aManagerCycle.length];
			// every 3rd manager-side report sits with a delegate instead - still
			// the "ממתין לאישורי" stage, but a party the tabs cannot express
			var sHandledByKey = mStatusToHandledBy[sStatus];
			if (sHandledByKey === "MANAGER" && i % 3 === 0) {
				sHandledByKey = "DELEGATION";
			}

			// 70% of rows in the current month/year, the rest spread to previous
			// months / last year so the other filter values have data too.
			var iYear = iCurYear;
			var iMonth = iCurMonth;
			if (i % 10 === 3) { iMonth = (iCurMonth === 1 ? 12 : iCurMonth - 1); iYear = (iCurMonth === 1 ? iCurYear - 1 : iCurYear); }
			else if (i % 10 === 7) { iYear = iCurYear - 1; }

			var sMonthKey = String(iMonth);
			var sMonth = (iMonth < 10 ? "0" + iMonth : String(iMonth)) + "/" + iYear;
			var aStates = aStatusCycle.indexOf(sStatus) === 3
				? aStepTemplates[2] // approved -> all done
				: aStepTemplates[i % 2];

			aRows.push({
				employeeName: "שם עובד שם עובד",
				employeeNumber: "225142" + (i % 10),
				population: oPop.text,
				populationKey: oPop.key,
				branch: oBranch.text,
				branchKey: oBranch.key,
				unit: oUnit.text,
				unitKey: oUnit.key,
				managerName: mManagerName[sManagerKey],
				managerKey: sManagerKey,
				handledByKey: sHandledByKey,
				isDirect: (i % 3 !== 0), // ~2/3 are direct reports
				approvalMonth: sMonth,
				approvalMonthKey: sMonthKey,
				approvalYearKey: String(iYear),
				extraMonths: (i % 4 === 0) ? 1 : 0,
				reportType: "ATTENDANCE",
				status: sStatus,
				processStep: aStates.filter(function (s) { return s === "done"; }).length,
				processTotal: 3,
				stepStates: aStates.map(function (s) { return { state: s }; })
			});
		}
		return aRows;
	}

	return {

		STATUS: STATUS,

		/**
		 * The logged-in user (name + role). Drives the role-based filter defaults.
		 * Replace with your real user service.
		 */
		getCurrentUser: function () {
			return CURRENT_USER;
		},

		/**
		 * Default status tab + default handling party for a given role.
		 * Falls back to the MANAGER defaults for unknown roles.
		 */
		getRoleDefaults: function (sRole) {
			return ROLE_DEFAULTS[sRole] || ROLE_DEFAULTS.MANAGER;
		},

		/**
		 * Static option lists used to populate the filter drop-downs.
		 * Replace with values coming from your backend if they are dynamic.
		 */
		getFilterOptions: function () {
			return {
				reportTypes: [
					{ key: "ATTENDANCE", text: "דו\"ח נוכחות" },
					{ key: "ABSENCE", text: "דו\"ח היעדרות" },
					{ key: "TRAINING", text: "דו\"ח השתלמות" }
				],
				years: (function () {
					var iCur = new Date().getFullYear();
					var a = [];
					for (var y = iCur; y >= iCur - 4; y--) {
						a.push({ key: String(y), text: String(y) });
					}
					return a;
				})(),
				months: [
					{ key: "1", text: "ינואר" }, { key: "2", text: "פברואר" },
					{ key: "3", text: "מרץ" }, { key: "4", text: "אפריל" },
					{ key: "5", text: "מאי" }, { key: "6", text: "יוני" },
					{ key: "7", text: "יולי" }, { key: "8", text: "אוגוסט" },
					{ key: "9", text: "ספטמבר" }, { key: "10", text: "אוקטובר" },
					{ key: "11", text: "נובמבר" }, { key: "12", text: "דצמבר" }
				],
				populations: aPopulations,
				branches: aBranches,
				units: aUnits,
				managers: aManagers,
				handlingParties: aHandlingParties,
				subordinateScopes: aSubordinateScopes
			};
		},

		/**
		 * ================= PLUG YOUR BACKEND CALL IN HERE =================
		 *
		 * Return a Promise that resolves with an array of rows (see shape above).
		 *
		 * Example with an OData V2 model:
		 *
		 *   getManagerReports: function (oComponent) {
		 *       var oModel = oComponent.getModel("myODataModel");
		 *       return new Promise(function (resolve, reject) {
		 *           oModel.read("/ManagerReports", {
		 *               success: function (oData) { resolve(oData.results); },
		 *               error: reject
		 *           });
		 *       });
		 *   }
		 *
		 * Example with fetch():
		 *
		 *   getManagerReports: function () {
		 *       return fetch("/api/manager-reports")
		 *           .then(function (r) { return r.json(); });
		 *   }
		 *
		 * For now it returns mock data after a short delay to simulate a call.
		 */
		getManagerReports: function (/* oComponent */) {
			return new Promise(function (resolve) {
				setTimeout(function () {
					resolve(_buildMockRows());
				}, 300);
			});
		}
	};
});
