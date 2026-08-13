sap.ui.define([], function () {
	"use strict";

	/* ============================================================================
	   Mock employee payload for the "נתוני כל העובדים" (AllEmployees) screen.
	   ----------------------------------------------------------------------------
	   The shape here is deliberately identical to what ZHR_EMPLOYEES_SRV /EmployeeSet
	   is expected to return: a FLAT list, one entry per employee, each carrying its
	   direct manager's id AND name. There is no `children` and no `level` - the
	   nested structure the sap.ui.table.TreeTable needs is derived on demand by
	   AllEmployees.controller#_buildTree.

	   Swap this module out for the real read in
	   AllEmployees.controller#_onRouteMatched - nothing else has to change.
	   ========================================================================= */

	/* --- reference data: אגף ------------------------------------------------ */
	var DIVISIONS = {
		D01: "אגף תקשוב וניהול מערכות מידע",
		D02: "אגף כספים ובקרה תקציבית",
		D03: "אגף משאבי אנוש והדרכה",
		D04: "אגף לוגיסטיקה ורכש"
	};

	/* --- reference data: יחידה (the comment marks the owning אגף) ----------- */
	var UNITS = {
		U01: "יחידת פיתוח יישומים",          // D01
		U02: "יחידת תשתיות ואבטחת מידע",     // D01
		U07: "יחידת מחשוב ענן ותקשורת",      // D01
		U05: "יחידת בקרה תקציבית",           // D02
		U03: "יחידת שכר ותנאי שירות",        // D03
		U04: "יחידת גיוס ומיון",             // D03
		U06: "יחידת רכש והתקשרויות"          // D04
	};

	/* --- reference data: אוכלוסייה ----------------------------------------- */
	var POPULATIONS = {
		MOD: "עובד/ת משהב\"ט",
		EXTERNAL: "עובד/ת חיצוני/ת",
		SOLDIER: "חייל/ת",
		NATIONAL_SERVICE: "שירות לאומי"
	};

	/* --- reference data: עובדים לא פעילים -----------------------------------
	   Employees whose employment has ended. In the backend this is a date test
	   (Endda < today), not a column; here it is a lookup so the ROWS table keeps
	   its seven columns.

	   All three are LEAVES on purpose. An inactive manager would be a data
	   problem rather than a test case: hiding it strands its reports, which
	   _buildTree then promotes to level 0, and the tree would silently gain
	   root-level rows every time the switch is flipped. Real leavers have their
	   reports reassigned first.

	   They sit at three different depths so the הצגת עובדים לא פעילים switch is
	   verifiable in both modes: דנה מזרחי is a direct report (level 0, and
	   therefore also visible in flat mode), ליאור נחום sits one level down,
	   תמר אוחיון two. */
	var INACTIVE_NUMBERS = ["2251547", "2251702", "2251614"];

	/**
	 * The logged-in manager. Not itself a row - it is the anchor whose direct
	 * reports form level 0 of the tree.
	 */
	var CURRENT_MANAGER = {
		employeeId: "M0000001",
		employeeName: "יוסי אלקבץ"
	};

	/* ----------------------------------------------------------------------------
	   The dataset. Columns:
	     [ employeeNumber, employeeName, isManager, managerId, populationKey,
	       divisionKey, unitKey ]

	   employeeId is always "E" + employeeNumber, so managerId can reference a
	   sibling row by "E<number>".

	   What this data exercises:
	     - 4 hierarchy levels (manager anchor -> 3 employee levels)
	     - a manager whose own manager is also a manager (רועי בן חמו / אבירם כהן)
	     - all four אוכלוסייה values, 4 אגף values, 7 יחידה values
	     - 9 direct reports of the logged-in manager (the "(9)" in the design)
	     - names spread over א/ב/ג/ד/ז/ח/ט/ל/מ/נ/ע/ר/ש/ת so both sort modes are
	       visibly verifiable
	     - one long אגף name (D01) that has to truncate in its column
	     - three inactive employees at three depths (see INACTIVE_NUMBERS)
	   ------------------------------------------------------------------------- */
	var ROWS = [
		["2251424", "אבירם כהן", true, "M0000001", "MOD", "D01", "U01"],
		["2251422", "מרים לוי", true, "M0000001", "MOD", "D01", "U02"],
		["2251324", "אורי שמש", true, "M0000001", "EXTERNAL", "D02", "U05"],
		["2251433", "בן ציון אדרי", false, "M0000001", "MOD", "D01", "U01"],
		["2251521", "גלית שרעבי", false, "M0000001", "EXTERNAL", "D01", "U07"],
		["2251547", "דנה מזרחי", false, "M0000001", "EXTERNAL", "D03", "U04"],
		["2251801", "זהר קליין", false, "M0000001", "MOD", "D02", "U05"],
		["2251802", "מיטל אזולאי", false, "M0000001", "SOLDIER", "D04", "U06"],
		["2251803", "עומר שגב", false, "M0000001", "NATIONAL_SERVICE", "D03", "U03"],

		["2251568", "רועי בן חמו", true, "E2251424", "MOD", "D01", "U01"],
		["2251611", "איתי פרץ", false, "E2251424", "SOLDIER", "D01", "U01"],
		["2251612", "נועה אלמוג", false, "E2251424", "NATIONAL_SERVICE", "D01", "U01"],

		["2251613", "שחר גולן", false, "E2251568", "MOD", "D01", "U02"],
		["2251614", "תמר אוחיון", false, "E2251568", "EXTERNAL", "D01", "U07"],

		["2251533", "יעל דהן", false, "E2251422", "EXTERNAL", "D01", "U02"],
		["2251426", "רונן ביטון", false, "E2251422", "MOD", "D01", "U02"],
		["2251427", "חן ברקוביץ", false, "E2251422", "MOD", "D01", "U07"],

		["2251701", "טל אביטן", false, "E2251324", "MOD", "D02", "U05"],
		["2251702", "ליאור נחום", false, "E2251324", "SOLDIER", "D02", "U05"]
	];

	/** employeeId -> employeeName, so managerName never drifts from managerId. */
	var NAME_BY_ID = ROWS.reduce(function (oMap, aRow) {
		oMap["E" + aRow[0]] = aRow[1];
		return oMap;
	}, {});
	NAME_BY_ID[CURRENT_MANAGER.employeeId] = CURRENT_MANAGER.employeeName;

	return {

		/**
		 * The logged-in manager - the tree's root anchor.
		 * In the real app this comes from the user context, not from here.
		 *
		 * @returns {{employeeId: string, employeeName: string}} a copy
		 */
		getCurrentManager: function () {
			return Object.assign({}, CURRENT_MANAGER);
		},

		/**
		 * The flat employee list, exactly as the backend is expected to deliver it.
		 * A fresh set of objects is built on every call, so callers can reshape or
		 * annotate the result without poisoning the next call.
		 *
		 * @returns {object[]} flat employee rows
		 */
		getFlat: function () {
			return ROWS.map(function (aRow) {
				var sNumber = aRow[0];
				var sManagerId = aRow[3];
				return {
					employeeId: "E" + sNumber,
					employeeNumber: sNumber,
					employeeName: aRow[1],
					// backend flag; _deriveIsManager re-derives and reconciles it
					isManager: aRow[2],
					isActive: INACTIVE_NUMBERS.indexOf(sNumber) === -1,
					managerId: sManagerId,
					// the service sends MgrEname; derived here so the mock stays consistent
					managerName: NAME_BY_ID[sManagerId] || "",
					populationKey: aRow[4],
					populationText: POPULATIONS[aRow[4]],
					divisionKey: aRow[5],
					divisionName: DIVISIONS[aRow[5]],
					unitKey: aRow[6],
					unitName: UNITS[aRow[6]]
				};
			});
		}
	};
});
