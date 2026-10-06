sap.ui.define([
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/base/Log",
	"modtimesheet/model/mockEmployees"
], function (Filter, FilterOperator, Log, mockEmployees) {
	"use strict";

	/* =========================================================================
	 * DataService
	 * -------------------------------------------------------------------------
	 * This is the SINGLE place the app talks to a data source.
	 *
	 * Three things talk to the real service now (see the OData section below):
	 * the ManagerSet entry call behind `getUserAuthorization()`, the rows behind
	 * `getManagerReports()`, and the POST behind `sendReminder()`. All three fall
	 * back to mock behaviour when the service is not reachable - which is what
	 * happens on this development machine, where there is no NetWeaver behind
	 * localhost:8080. Everything else here is still mock.
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
	 *   managerName:        string,   // "שם מנהל ישיר"   (column, searchable)
	 *   managerKey:         string,   // filter key for the "שם מנהל ישיר" filter
	 *   employeeMail:       string,   // EmployeeMail - the address שליחת תזכורת
	 *                                // proposes for this row (no column of its own)
	 *   handledByKey:       string,   // "נמצא בטיפול": EMPLOYEE | MANAGER | HR | DELEGATION
	 *                                // ("" when nobody holds it, i.e. approved).
	 *                                // Must agree with `status`: the status tabs
	 *                                // and this filter are synced on screen.
	 *   isDirect:           bool,     // "כפיפים": true = direct report of the manager
	 *   approvalMonth:      string,   // "חודש לאישור"    e.g. "01/2025"
	 *   approvalMonthKey:   string,   // month filter key "1".."12"
	 *   approvalYearKey:    string,   // year filter key  "2021".."2025"
	 *   extraMonths:        int,      // >0 shows the "N+" badge next to the month
	 *   reportType:         string,   // ATTENDANCE | ABSENCE | TRAINING - stamped
	 *                                // from the request; no filter on screen any more
	 *   status:             string,   // one of the STATUS.* keys below
	 *   processStep:        int,      // current step (shows "step/total")
	 *   processTotal:       int,      // total steps
	 *   stepStates:         [{state}] // per-dot: {state:"done"|"current"|"open"}
	 * }
	 * ========================================================================= */

	/**
	 * The months, in one place: the חודש drop-down reads them, and so does the
	 * subject line of שליחת תזכורת - which names a month in words, and must name
	 * it the way the filter above the table does.
	 */
	var MONTH_NAMES = [
		"ינואר", "פברואר", "מרץ", "אפריל", "מאי", "יוני",
		"יולי", "אוגוסט", "ספטמבר", "אוקטובר", "נובמבר", "דצמבר"
	];

	// Status keys - drive the four tabs at the top of the screen.
	var STATUS = {
		PENDING_EMPLOYEE: "PENDING_EMPLOYEE", // ממתין לעובד
		PENDING_MY_APPROVAL: "PENDING_MY_APPROVAL", // ממתין למנהל
		PENDING_HR: "PENDING_HR", // ממתין למשא"ן
		APPROVED: "APPROVED" // אושרו
	};

	/* ---- הרשאות המשתמש -------------------------------------------------------
	   The five authorisation levels, and the one fact that keeps the rest of this
	   file simple: each level's code is ALSO the ImManagerType the service takes.
	   The level a user holds therefore already names the population the backend
	   will hand them, so nothing has to translate between "who the user is" and
	   "what to ask for" - see loadManagerContext.
	   ---------------------------------------------------------------------- */
	var ROLE = {
		EMPLOYEE: "EMPL", // עובד
		MANAGER: "TMGR",  // מנהל ישיר
		HR: "TADM",       // משא"ן
		CIVILIAN: "TMSA", // אמ"ש
		SUPPLY: "TSLD"    // אמרכל
	};

	/**
	 * Which "נתוני נוכחות כפיפים" cards each level sees, in display order.
	 *
	 * The EMPTY list is not a missing entry - it is the whole of עובד: a plain
	 * employee gets the top block of דף הבית and nothing else, which is what
	 * showSubordinates false draws. The rest is written out level by level,
	 * exactly as the rules were given, rather than derived from a hierarchy that
	 * does not actually hold (משא"ן and אמ"ש share a set; אמרכל's is different
	 * in a different direction):
	 *
	 *   TMGR  מנהל ישיר - כפיפים + עובדי האגף
	 *   TADM  משא"ן     - everything except חיילות
	 *   TMSA  אמ"ש      - everything except חיילות
	 *   TSLD  אמרכל     - everything except אמ"ש
	 *
	 * צפייה בכל העובדים is deliberately NOT in here: it is a launcher, not a
	 * counter card, and it belongs to the block rather than to a level - so every
	 * level that has the block has it, and עובד has neither.
	 */
	var ROLE_CARDS = {
		EMPL: [],
		TMGR: ["SUBORDINATES", "DIVISION"],
		TADM: ["SUBORDINATES", "DIVISION", "CIVILIAN"],
		TMSA: ["SUBORDINATES", "DIVISION", "CIVILIAN"],
		TSLD: ["SUBORDINATES", "DIVISION", "SOLDIERS"]
	};

	// Level -> default status tab + default "נמצא בטיפול" on דוחות נוכחות.
	// A ממונה lands on "ממתין למנהל"; everyone above them on "ממתין למשא"ן".
	var ROLE_DEFAULTS = {
		EMPL: { statusTab: STATUS.PENDING_MY_APPROVAL, handledByKey: "MANAGER" },
		TMGR: { statusTab: STATUS.PENDING_MY_APPROVAL, handledByKey: "MANAGER" },
		TADM: { statusTab: STATUS.PENDING_HR, handledByKey: "HR" },
		TMSA: { statusTab: STATUS.PENDING_HR, handledByKey: "HR" },
		TSLD: { statusTab: STATUS.PENDING_HR, handledByKey: "HR" }
	};

	/**
	 * The logged-in user on a mock host. Deployed, this is not used at all: the
	 * ManagerSet entry call answers instead - see _loadUserAuthorization.
	 *
	 * The identity is mockEmployees' current manager, so דף הבית greets the same
	 * person whose people נתוני כל העובדים lists and whose name is the "שם מנהל
	 * ישיר" of the rows on דוחות נוכחות. Three screens, one person.
	 *
	 * Switch levels without touching code: ?role=TMGR (or TADM / TMSA / TSLD /
	 * EMPL) on the URL. EMPL is worth trying - it is the one that takes the whole
	 * subordinate block away.
	 */
	var MOCK_USER = {
		// Deployed, the SAP user is whatever ManagerSet ANSWERS with. Here there is
		// no service to answer, so the mock stands in for the response - and it
		// names the same user as LOGIN_USER_SEED (which stands in for the filter)
		// so that mock and service describe one person. ?user= overrides both.
		userId: "W04154",
		//
		// Employee on ManagerEmployeesSet - the manager's own personnel number,
		// zero-padded the way SAP carries it. Deployed this comes back as
		// PersonnelNumber from the entry call; here it stays tied to
		// mockEmployees, whose rows are the ones it has to match.
		pernr: "00002251400",
		displayName: mockEmployees.getCurrentManager().employeeName,
		role: ROLE.HR
	};

	/**
	 * The authorisation as it stands right now, so the parts of the app that run
	 * before the (asynchronous) answer arrives still have a user to work with.
	 * getUserAuthorization overwrites it with the real one.
	 */
	var oCurrentUser = null;

	/** ?role=TMGR - a dev override for the mock level. */
	function _roleOverride() {
		var aMatch = /[?&]role=(EMPL|TMGR|TADM|TMSA|TSLD)/i.exec(window.location.search);
		return aMatch ? aMatch[1].toUpperCase() : null;
	}

	/** The mock authorisation, honouring ?role=. */
	function _mockAuthorization() {
		var sRole = _roleOverride() || MOCK_USER.role;
		return {
			// ?user= reads the same here as it does on the real entry call
			userId: _userOverride() || MOCK_USER.userId,
			pernr: MOCK_USER.pernr,
			displayName: MOCK_USER.displayName,
			role: sRole,
			// one role in the mock, where the service can return several
			roles: [sRole],
			homeCards: (ROLE_CARDS[sRole] || []).slice(),
			email: "",
			department: "",
			departmentName: "",
			unit: ""
		};
	}

	/** The user as currently known - the mock one until the service answers. */
	function _currentUser() {
		if (!oCurrentUser) {
			oCurrentUser = _mockAuthorization();
		}
		return oCurrentUser;
	}

	/* ---------------------------------------------------------------------------
	   The active period - which month the app is working on
	   ------------------------------------------------------------------------
	   A month is chased, closed, and then left alone: up to the 10th the month
	   that just ended is still being corrected, so that is the open one; from the
	   11th it is settled and the current month takes over.

	   The 10th is a business rule, not a calendar fact - it is the day the previous
	   month stops accepting corrections. Three things now read it: the month דף
	   הבית opens on, the period the shared ManagerEmployees call asks for, and the
	   month a תזכורת names. One rule, one place.
	   ------------------------------------------------------------------------ */
	function _activePeriod(oNow) {
		var oDate = oNow || new Date();
		var iMonth = oDate.getMonth(); // 0-based
		var iYear = oDate.getFullYear();

		if (oDate.getDate() <= 10) {
			iMonth -= 1;
			// the first ten days of January are still chasing December
			if (iMonth < 0) {
				iMonth = 11;
				iYear -= 1;
			}
		}

		return { month: iMonth + 1, year: iYear, name: MONTH_NAMES[iMonth] };
	}

	/**
	 * A 1..12 month as the pair of UTC midnights the service is filtered on.
	 *
	 * UTC and not local, and this is not a detail: the model formats an
	 * Edm.DateTime filter value from a Date's UTC components, so a locally-built
	 * midnight travels as the day BEFORE - 01/08 asked for in Israel (UTC+3)
	 * reaches the backend as 31/07T21:00, a whole month off at a month boundary.
	 */
	function _periodBounds(iYear, iMonth) {
		return {
			begin: new Date(Date.UTC(iYear, iMonth - 1, 1)),
			// day 0 of the next month is the last day of this one
			end: new Date(Date.UTC(iYear, iMonth, 0))
		};
	}

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

	/* ---- mock reference data -------------------------------------------------
	   One employee population behind all three screens.

	   The four option lists are DERIVED from mockEmployees instead of being
	   written out a second time, and that is the whole point: דוחות נוכחות and
	   נתוני כל העובדים now take their filter options from one shared call
	   (loadManagerContext), so a list that did not agree with the rows would
	   quietly filter the entire table away. Deployed, the options and the rows
	   both come out of ManagerEmployeesSet and agree by construction - here they
	   have to be made to agree.
	   ---------------------------------------------------------------------- */
	var aMockEmployees = mockEmployees.getFlat();

	var aPopulations = _distinct(aMockEmployees, "populationKey", "populationText");
	var aBranches = _distinct(aMockEmployees, "divisionKey", "divisionName");
	var aUnits = _distinct(aMockEmployees, "unitKey", "unitName");
	// שם מנהל ישיר is keyed by the manager's NAME and not by an id, because
	// ManagerEmployees carries ManagerName and no manager id at all - see
	// _mapManagerEmployees. The mock follows the service, not the other way round.
	var aManagers = _distinct(aMockEmployees, "managerName", "managerName");

	// השלמת תהליך - the three-step bar, as [done|current|open] triples.
	var aStepTemplates = [
		["done", "current", "open"],
		["done", "done", "current"],
		["done", "done", "done"]
	];

	/**
	 * אוכלוסייה code -> label. ManagerEmployees carries PopulationType as a bare
	 * code with no text field beside it, so the label has to come from somewhere;
	 * an unknown code falls back to itself rather than to an empty cell.
	 */
	var POPULATION_TEXT = aMockEmployees.reduce(function (oMap, oEmp) {
		oMap[oEmp.populationKey] = oEmp.populationText;
		return oMap;
	}, {});

	/**
	 * Populations that belong to נוכחות חיילות rather than to נוכחות אמ"ש.
	 * שירות לאומי sits with the soldiers because that is who שלישות handles.
	 */
	var SOLDIER_POPULATIONS = ["SOLDIER", "NATIONAL", "NATIONAL_SERVICE"];

	function _isSoldierPopulation(sKey) {
		return SOLDIER_POPULATIONS.indexOf(sKey) !== -1;
	}

	/**
	 * The mock rows - one per employee in the shared mock population, in the row
	 * shape documented at the top of this file.
	 *
	 * Identity and org fields come straight from mockEmployees, so the rows agree
	 * with the option lists derived from the same source. Only the approval side
	 * is invented here: it is absent from mockEmployees, and it is cycled rather
	 * than random so every status tab, every handling party and both step
	 * templates have rows out of the box.
	 *
	 * @param {object} [oPeriod] {year, month} - the period most rows are stamped
	 *   with (default: the active one, see _activePeriod)
	 * @returns {object[]} rows
	 */
	function _buildMockRows(oPeriod) {
		var oBase = oPeriod || _activePeriod();
		var sRootId = mockEmployees.getCurrentManager().employeeId;
		var aStatusCycle = [
			STATUS.PENDING_MY_APPROVAL, STATUS.PENDING_HR, STATUS.PENDING_EMPLOYEE,
			STATUS.APPROVED, STATUS.PENDING_MY_APPROVAL, STATUS.PENDING_MY_APPROVAL,
			STATUS.PENDING_HR, STATUS.PENDING_EMPLOYEE
		];
		// "נמצא בטיפול" describes the same thing as the status tab - the party the
		// report waits on - so it is derived from the status rather than cycled
		// independently, otherwise the two (now synced) filters contradict each
		// other on screen. Approved reports wait on nobody.
		var mStatusToHandledBy = {};
		mStatusToHandledBy[STATUS.PENDING_EMPLOYEE] = "EMPLOYEE";
		mStatusToHandledBy[STATUS.PENDING_MY_APPROVAL] = "MANAGER";
		mStatusToHandledBy[STATUS.PENDING_HR] = "HR";
		mStatusToHandledBy[STATUS.APPROVED] = "";

		return aMockEmployees.map(function (oEmp, i) {
			var sStatus = aStatusCycle[i % aStatusCycle.length];
			// every 3rd manager-side report sits with a delegate instead - still
			// the "ממתין למנהל" stage, but a party the tabs cannot express
			var sHandledByKey = mStatusToHandledBy[sStatus];
			if (sHandledByKey === "MANAGER" && i % 3 === 0) {
				sHandledByKey = "DELEGATION";
			}

			// Most rows in the requested month, the rest spread to the month before
			// and to last year, so שנה / חודש have something to find as well.
			var iYear = oBase.year;
			var iMonth = oBase.month;
			if (i % 10 === 3) {
				iMonth = (oBase.month === 1 ? 12 : oBase.month - 1);
				iYear = (oBase.month === 1 ? oBase.year - 1 : oBase.year);
			} else if (i % 10 === 7) {
				iYear = oBase.year - 1;
			}

			var aStates = sStatus === STATUS.APPROVED
				? aStepTemplates[2] // approved -> all done
				: aStepTemplates[i % 2];

			return {
				employeeId: oEmp.employeeId,
				employeeNumber: oEmp.employeeNumber,
				employeeName: oEmp.employeeName,

				population: oEmp.populationText,
				populationKey: oEmp.populationKey,
				branch: oEmp.divisionName,
				branchKey: oEmp.divisionKey,
				unit: oEmp.unitName,
				unitKey: oEmp.unitKey,

				// keyed by name, as the service delivers it
				managerName: oEmp.managerName,
				managerKey: oEmp.managerName,

				orgKey: oEmp.divisionKey,
				adminName: "",
				employeeMail: "e" + oEmp.employeeNumber + "@mod.gov.il",
				managerMail: "",
				adminMail: "",

				handledByKey: sHandledByKey,
				// כפיפים ישירים: the people who report to the logged-in manager
				// personally, as opposed to everyone further down the tree
				isDirect: oEmp.managerId === sRootId,
				isActive: oEmp.isActive !== false,

				approvalMonth: (iMonth < 10 ? "0" + iMonth : String(iMonth)) + "/" + iYear,
				approvalMonthKey: String(iMonth),
				approvalYearKey: String(iYear),
				extraMonths: (i % 4 === 0) ? 1 : 0,
				reportType: "ATTENDANCE",
				status: sStatus,
				processStep: aStates.filter(function (s) { return s === "done"; }).length,
				processTotal: 3,
				stepStates: aStates.map(function (s) { return { state: s }; })
			};
		});
	}

	/* ============================================================================
	   OData - ZHR_TM_ATTENDANCE_SYSTEM_SRV_N
	   ----------------------------------------------------------------------------
	   The real source of דוחות נוכחות באחריות ממונה.

	   Model name:  ZHR_TM_ATTENDANCE_SYSTEM_SRV_N
	   Service URI: manifest.json > sap.app/dataSources, under that same name
	   EntitySets:  /ManagerSet           (EntityType Manager, key UserName)
	                  GET - the ENTRY call: who is logged in, their personnel
	                  number and their roles. See the ManagerSet section below.
	                /ManagerEmployeesSet  (EntityType ManagerEmployees, key Employee)
	                  GET - the rows of דוחות נוכחות, and the manager context
	                /MailSendingSet       (EntityType MailSending, key Subject +
	                                       Body + Recipients)
	                  POST - שליחת תזכורת; see sendReminder

	   The model is built in Component.js rather than declared in sap.ui5/models -
	   see the MOCK note below for why.

	   The four Im* properties are input parameters, not data: the entity type
	   declares them, but they only ever travel INTO the call. They are all
	   mandatory, so a read without them fails in the backend rather than
	   returning everything.

	     ImBeginDate    Edm.DateTime  start of the requested period
	     ImEndDate      Edm.DateTime  end of the requested period
	     ImManagerUser  Edm.String    the SAP user whose data is asked for
	     ImManagerType  Edm.String    WHICH population - see MANAGER_TYPE below
	     ImDepartment   Edm.String    optional narrowing to one department
	     Employee       Edm.String    the MANAGER's own personnel number - the key
	                                  property, used on a read as "whose people"
	     ImOldReports   Edm.Boolean   optional: only what is still waiting from
	                                  months that have already passed

	   ImManagerUser and the manager's PersonnelNumber both come from the entry
	   call - /ManagerSet, see the section below it. This set is never asked who
	   the user is; it is told.

	   ImOldReports is the "ממתינים לאישור מחודשים קודמים" toggle on the reports
	   screen. It is NOT in the entity type yet - the name follows the Im*
	   convention of the four above, and is sent only while the toggle is on, so
	   until the backend declares it nothing is asked for that was not asked for
	   before. Confirm the property name with the backend when it lands; this is
	   the one place it is written.

	   They are sent as $filter terms - confirmed with the backend side: GET_ENTITYSET
	   reads them off it_filter_select_options. Passing Date objects rather than
	   pre-formatted strings is deliberate: the model formats them as
	   datetime'2025-08-01T00:00:00' off the Edm.DateTime in the metadata, so the
	   literal syntax is never hand-built here.

	   MOCK - and why it is decided by the ENVIRONMENT, not by a failed request:
	   this machine has no NetWeaver behind localhost:8080, so here the service can
	   only ever fail. Waiting for it to fail before showing mock rows means the
	   screen sits on its busy indicator until the request gives up - and if the
	   request hangs instead of answering, it never comes back at all. So on
	   localhost the service is not called AT ALL (Component.js does not even build
	   the model) and the mock rows are handed out immediately.

	   Deployed - anything that is not localhost - the opposite is true: the service
	   is the only source, and a failure surfaces as a failure. Mock data must never
	   stand in for a broken backend in production, where nobody would notice.

	   Force either side with ?mock=true / ?mock=false on the URL: ?mock=false on
	   localhost is how you test against a real service through a proxy, and
	   ?mock=true anywhere pins the screen to demo data.
	   ========================================================================= */

	var ODATA_MODEL_NAME = "ZHR_TM_ATTENDANCE_SYSTEM_SRV_N";
	var MANAGER_EMPLOYEES_SET = "/ManagerEmployeesSet";

	/**
	 * The entry call - see the ManagerSet section further down.
	 * EntityType Manager, key UserName, navigation property Roles.
	 */
	var MANAGER_SET = "/ManagerSet";

	/**
	 * שליחת תזכורת posts here. EntityType MailSending, three Edm.String
	 * properties - Subject, Body, Recipients - and all three are the key, which
	 * is why the same message can only be sent once with identical text.
	 */
	var MAIL_SENDING_SET = "/MailSendingSet";

	/**
	 * Recipients is ONE string, not a collection, so the addresses are joined.
	 * Semicolon because that is what SAPconnect splits a recipient list on.
	 */
	var RECIPIENT_SEPARATOR = ";";

	/**
	 * ImManagerType - which population the screen was opened for. The four values
	 * are the four "נתוני נוכחות כפיפים" cards on דף הבית, which is where the
	 * screen is opened from; a direct entry with no card falls back to TMGR.
	 */
	var MANAGER_TYPE = {
		SUBORDINATES: "TMGR", // נוכחות כפיפים      - מנהל ישיר
		DIVISION: "TADM",     // נוכחות עובדי האגף  - משא"ן
		CIVILIAN: "TMSA",     // נוכחות אמ"ש
		SOLDIERS: "TSLD"      // נוכחות חיילות
	};
	var DEFAULT_MANAGER_TYPE = MANAGER_TYPE.SUBORDINATES;

	/**
	 * "כפיפים" - how deep the card looks, which is the second thing a דף הבית card
	 * decides about the screen it opens.
	 *
	 *   DIRECT  only the people whose own ממונה is the user
	 *   ALL     the whole subtree - a report of a report is still in the אגף
	 *
	 * נוכחות כפיפים is the one card that means "mine, personally"; every other
	 * card is about a population rather than about a reporting line, so all of
	 * them look the whole way down. A direct entry with no card behind it reads
	 * as כפיפים, for the same reason it reads as TMGR above.
	 */
	var SUBORDINATE_SCOPE = {
		SUBORDINATES: "DIRECT",
		DIVISION: "ALL",
		CIVILIAN: "ALL",
		SOLDIERS: "ALL"
	};
	var DEFAULT_SUBORDINATE_SCOPE = SUBORDINATE_SCOPE.SUBORDINATES;

	/** Set by every getManagerReports call - see isLastLoadMock(). */
	var bLastLoadWasMock = true;

	/**
	 * ?mock=true / ?mock=false on the URL.
	 * @returns {boolean|null} the forced mode, or null when nothing is forced
	 */
	function _mockOverride() {
		var aMatch = /[?&]mock=(true|false)/i.exec(window.location.search);
		return aMatch ? aMatch[1].toLowerCase() === "true" : null;
	}

	/**
	 * This development machine, i.e. a host that cannot have a NetWeaver stack
	 * behind it. A file:// page has no hostname at all, hence the empty string.
	 *
	 * Deliberately a HOST test and not "is the service reachable": the second one
	 * can only be answered by making a request and waiting for it, which is the
	 * loading screen this avoids.
	 */
	function _isLocalHost() {
		var sHost = window.location.hostname;
		return sHost === "localhost"
			|| sHost === "127.0.0.1"
			|| sHost === "[::1]"
			|| sHost === "::1"
			|| sHost === "";
	}

	/** The URL override if there is one, the host otherwise. */
	function _isMockEnvironment() {
		var bForced = _mockOverride();
		return bForced === null ? _isLocalHost() : bForced;
	}

	/**
	 * Fills in what the caller left out, so the four mandatory params are never
	 * empty.
	 *
	 * The two dates are built in UTC, and this is not a detail: the model formats an
	 * Edm.DateTime filter value from a Date's UTC components, so a locally-built
	 * midnight travels as the day BEFORE - 01/08 asked for in Israel (UTC+3) reaches
	 * the backend as 31/07T21:00, one whole month off at a month boundary. Anything
	 * passing beginDate / endDate in has to do the same (see buildPeriod in
	 * ManagerReports.controller).
	 */
	function _normaliseReportParams(oParams) {
		var o = oParams || {};
		var oUser = _currentUser();
		var oPeriod = _activePeriod();
		var oBounds = _periodBounds(oPeriod.year, oPeriod.month);

		return {
			managerType: o.managerType || DEFAULT_MANAGER_TYPE,
			managerUser: o.managerUser || oUser.userId,
			// not sent - see _mapManagerEmployees / isDirect
			managerName: o.managerName || oUser.displayName || "",
			// Employee - the MANAGER's own personnel number. On a read it is the
			// person the question is asked on behalf of, not a row being fetched.
			employee: o.employee || oUser.pernr || "",
			// default period: the active month, first day to last day
			beginDate: o.beginDate || oBounds.begin,
			endDate: o.endDate || oBounds.end,
			department: o.department || "",
			// ממתינים לאישור מחודשים קודמים - see the note above
			oldReports: !!o.oldReports,
			reportType: o.reportType || "ATTENDANCE"
		};
	}

	/** The mandatory input parameters, as $filter terms. */
	function _buildRequestFilters(oParams) {
		var aFilters = [
			new Filter("ImBeginDate", FilterOperator.EQ, oParams.beginDate),
			new Filter("ImEndDate", FilterOperator.EQ, oParams.endDate),
			// ImManagerUser stays alongside Employee rather than being replaced by
			// it: the metadata marks it Nullable="false", so a read without it is
			// rejected by the backend. The two say different things anyway - the
			// SAP user is WHO is asking, the personnel number is WHOSE people are
			// being asked for, and only the second one has a value on דף הבית.
			new Filter("ImManagerUser", FilterOperator.EQ, oParams.managerUser),
			new Filter("ImManagerType", FilterOperator.EQ, oParams.managerType)
		];
		if (oParams.employee) {
			aFilters.push(new Filter("Employee", FilterOperator.EQ, oParams.employee));
		}
		// Optional - sent only when the caller narrows to one department, so an
		// empty string never reaches the backend as a real restriction.
		if (oParams.department) {
			aFilters.push(new Filter("ImDepartment", FilterOperator.EQ, oParams.department));
		}
		// Optional in the same sense, and for the same reason: "off" is the
		// absence of the restriction, not a request for the reports of THIS
		// month, so a false never travels.
		if (oParams.oldReports) {
			aFilters.push(new Filter("ImOldReports", FilterOperator.EQ, true));
		}
		return aFilters;
	}

	function _readManagerEmployees(oModel, oParams) {
		return new Promise(function (resolve, reject) {
			oModel.read(MANAGER_EMPLOYEES_SET, {
				filters: _buildRequestFilters(oParams),
				success: function (oData) {
					resolve((oData && oData.results) || []);
				},
				error: reject
			});
		});
	}

	/**
	 * What went wrong, in words a person can be shown.
	 *
	 * The v2 model hands an error object whose own `message` is the transport
	 * ("HTTP request failed"), while the one worth reading - the ABAP exception,
	 * the authorisation refusal, the validation text - is inside responseText. So
	 * the body is unpacked first and the transport message is only the fallback.
	 *
	 * Both encodings are handled because the gateway picks between them off the
	 * request's Accept header, and an error raised BEFORE dispatch (a 500 from
	 * the ICF node, say) can come back as neither - hence the last resort.
	 *
	 * @param {object} oError the error the model reported
	 * @returns {string} the message, or "" when the error carries none
	 */
	function _serviceErrorMessage(oError) {
		var sBody = oError && oError.responseText;

		if (sBody) {
			try {
				var oJson = JSON.parse(sBody);
				var oMessage = oJson && oJson.error && oJson.error.message;
				if (oMessage) {
					// {"value": "..."} in v2 JSON, a bare string in some variants
					return (typeof oMessage === "string" ? oMessage : oMessage.value) || "";
				}
			} catch (oParseError) {
				// an XML error body - <error><message xml:lang="he">...</message>
				var aMatch = /<message[^>]*>([\s\S]*?)<\/message>/i.exec(sBody);
				if (aMatch) {
					return aMatch[1].trim();
				}
			}
		}

		return (oError && (oError.message || oError.statusText)) || "";
	}

	/**
	 * An Error carrying the readable message, with the raw one kept on it for the
	 * console. Screens show `message` and nothing else.
	 */
	function _toServiceError(oError, sFallback) {
		var oWrapped = new Error(_serviceErrorMessage(oError) || sFallback);
		oWrapped.serviceError = oError;
		return oWrapped;
	}

	/** POST one entry to /MailSendingSet. */
	function _createMailSending(oModel, oEntry) {
		return new Promise(function (resolve, reject) {
			oModel.create(MAIL_SENDING_SET, oEntry, {
				success: resolve,
				error: function (oError) {
					reject(_toServiceError(oError, "שליחת התזכורת נכשלה"));
				}
			});
		});
	}

	/** "00002251424" -> "2251424" for display; the raw value stays in employeeId. */
	function _trimPernr(sPernr) {
		return String(sPernr || "").replace(/^0+/, "");
	}

	/** An ABAP boolean as the model delivers it: "X" / true. */
	function _isSet(vValue) {
		return vValue === true || vValue === "X" || vValue === "x";
	}

	/**
	 * Which party a report is waiting on, from the four approval flags.
	 *
	 * The entity carries no status column, but it does carry the approval chain -
	 * EmployeeApproved -> SupervisiorApproved -> AdminApproved ->
	 * SuperadminApproved - and "waiting on" is simply the first link that has not
	 * been signed. Derived from the flags rather than read off WaitingToApproverCode
	 * because the flags are booleans with one meaning, while the code's domain
	 * values are not documented anywhere on this side.
	 *
	 * A row that carries NONE of the four flags returns null - UNKNOWN, as opposed
	 * to the empty string's "waiting on nobody". A service that stopped sending
	 * them would otherwise pile every row onto the first stage and report it as
	 * fact.
	 *
	 * @param {object} oEntry a raw ManagerEmployees entry
	 * @returns {string|null} EMPLOYEE | MANAGER | HR | DELEGATION, "" when fully
	 *   approved, null when the entry carries no approval chain at all
	 */
	function _waitingParty(oEntry) {
		var bHasChain = ["EmployeeApproved", "SupervisiorApproved", "AdminApproved",
			"SuperadminApproved"].some(function (sField) {
			return oEntry[sField] !== undefined && oEntry[sField] !== null;
		});
		if (!bHasChain) {
			return null;
		}

		if (!_isSet(oEntry.EmployeeApproved)) { return "EMPLOYEE"; }
		if (!_isSet(oEntry.SupervisiorApproved)) { return "MANAGER"; }
		if (!_isSet(oEntry.AdminApproved)) { return "HR"; }
		if (!_isSet(oEntry.SuperadminApproved)) { return "DELEGATION"; }
		return "";
	}

	/**
	 * The status tab a waiting party belongs to.
	 *
	 * שליחות has no tab of its own, so it maps to nothing and those rows show up
	 * under "הכל" only - which is honest, rather than filing them under a stage
	 * they are not at. An unknown party maps to nothing for the same reason.
	 */
	function _statusOf(sParty) {
		switch (sParty) {
			case "EMPLOYEE": return STATUS.PENDING_EMPLOYEE;
			case "MANAGER": return STATUS.PENDING_MY_APPROVAL;
			case "HR": return STATUS.PENDING_HR;
			case "": return STATUS.APPROVED;
			default: return ""; // DELEGATION, or no chain at all
		}
	}

	function _fullName(oEntry) {
		return [oEntry.FirstName, oEntry.LastName].filter(Boolean).join(" ").trim();
	}

	/**
	 * ManagerEmployees -> the row shape at the top of this file.
	 *
	 * The service does not carry the approval side of a row yet - status, נמצא
	 * בטיפול, חודש לאישור and השלמת תהליך are all absent from the entity type
	 * ("יכול להיות שחסר עמודות, יוסיפו בהמשך"). Rather than invent them:
	 *
	 *   - חודש לאישור comes from the period that was ASKED for, which is true by
	 *     construction and is what the user picked in the filter bar.
	 *   - status / handledByKey stay empty, so no row lands in a status tab it
	 *     was not put in by the backend. The screen notices that nothing carries a
	 *     status and lands on "הכל" instead of on an empty tab.
	 *   - processTotal is null, which formatter.stepText renders as an empty
	 *     cell rather than as a misleading "0/0".
	 *
	 * When the columns arrive, map them here - and only here.
	 */
	function _mapManagerEmployees(aResults, oParams) {
		// UTC components, to match how the period was built - see
		// _normaliseReportParams
		var oPeriod = oParams.beginDate;
		var iYear = oPeriod.getUTCFullYear();
		var iMonth = oPeriod.getUTCMonth() + 1;
		// the logged-in person's name, which is the only handle the entity gives
		// for "is this one of MY people" - see isDirect below
		var sSelfName = oParams.managerName || "";

		return (aResults || []).map(function (oEntry) {
			// אוכלוסייה: PopulationType is a code with no text beside it on the
			// entity, so it doubles as the filter key and POPULATION_TEXT supplies
			// a label - falling back to the code itself for a value we do not know.
			var sPopulationKey = oEntry.PopulationType || "";
			var sParty = _waitingParty(oEntry);

			return {
				// Employee is the entity's key and its personnel number; the raw,
				// zero-padded value stays as the id, the trimmed one is displayed.
				employeeId: oEntry.Employee,
				employeeNumber: _trimPernr(oEntry.Employee),
				employeeName: _fullName(oEntry),

				population: POPULATION_TEXT[sPopulationKey] || sPopulationKey,
				populationKey: sPopulationKey,

				// אנף / יחידה - code as the filter key, name as the display text.
				// The entity has no Department output field: OrgKey is the org unit
				// the row hangs under and DepartmentName is its name.
				branch: oEntry.DepartmentName || oEntry.OrgKey || "",
				branchKey: oEntry.OrgKey || "",
				unit: oEntry.UnitName || oEntry.UnitCode || "",
				unitKey: oEntry.UnitCode || "",

				// No manager id on the entity - the name is the key as well.
				managerName: oEntry.ManagerName || "",
				managerKey: oEntry.ManagerName || "",

				// carried through untouched: not on screen today, but the mail
				// addresses and the org key are what a "פנייה לממונה" action needs
				orgKey: oEntry.OrgKey || "",
				adminName: oEntry.AdminName || "",
				employeeMail: oEntry.EmployeeMail || "",
				managerMail: oEntry.ManagerMail || "",
				adminMail: oEntry.AdminMail || "",

				isActive: oEntry.ActiveInd === undefined ? true : _isSet(oEntry.ActiveInd),

				// כפיפים ישירים: the rows whose own ממונה is the logged-in person.
				// By NAME, because that is all ManagerName gives - so a namesake
				// would read as direct. The moment the entity carries a manager
				// personnel number, compare on that instead; this is the one line
				// that has to change.
				isDirect: !!sSelfName && oEntry.ManagerName === sSelfName,

				// --- the approval chain, folded into one stage ---
				handledByKey: sParty === null ? "" : sParty,
				status: _statusOf(sParty),

				// --- from the request, not from the response ---
				approvalMonth: (iMonth < 10 ? "0" + iMonth : String(iMonth)) + "/" + iYear,
				approvalMonthKey: String(iMonth),
				approvalYearKey: String(iYear),
				reportType: oParams.reportType,

				// --- not in the service yet ---
				extraMonths: 0,
				processStep: 0,
				processTotal: null,
				stepStates: []
			};
		});
	}

	/**
	 * דוחות נוכחות באחריות ממונה - the rows of the table, and the rows behind the
	 * shared manager context.
	 *
	 * Reads /ManagerEmployeesSet off the ZHR_TM_ATTENDANCE_SYSTEM_SRV_N model and
	 * maps it onto the row shape documented at the top of this file - unless this
	 * is a mock environment (localhost / ?mock=true), where it resolves with the
	 * mock rows without contacting anything. A read that DOES go out and fails
	 * rejects, so a broken backend is never papered over with demo data.
	 *
	 * @param {sap.ui.core.UIComponent} oComponent the owner component (holds the model)
	 * @param {object} [oParams] the request
	 *   {string} managerType TMGR | TADM | TMSA | TSLD  (default TMGR)
	 *   {string} managerUser SAP user             (default the current user)
	 *   {string} employee    the MANAGER's own personnel number, sent as Employee
	 *   {string} managerName the manager's name - not sent, used to decide which
	 *                        rows are direct reports (see _mapManagerEmployees)
	 *   {Date}   beginDate   start of the period (default: the active month)
	 *   {Date}   endDate     end of the period   (default: the active month)
	 *   {string} department  optional ImDepartment
	 *   {boolean} oldReports ממתינים לאישור מחודשים קודמים - sent as ImOldReports,
	 *                        and only when true
	 *   {string} reportType  stamped onto every row (default ATTENDANCE); the
	 *                        screen no longer offers a סוג דוח filter over it
	 * @returns {Promise<object[]>} the rows
	 */
	function getManagerReports(oComponent, oParams) {
		var oRequest = _normaliseReportParams(oParams);
		var oModel = oComponent && oComponent.getModel(ODATA_MODEL_NAME);

		// Mock first, and without touching the model: no request, no metadata to
		// wait for, no busy indicator hanging on a host that has no backend.
		if (_isMockEnvironment() || !oModel) {
			if (!oModel && !_isMockEnvironment()) {
				// deployed, but the model is missing - a configuration error worth
				// seeing rather than a reason to show demo data
				return Promise.reject(new Error("DataService: model "
					+ ODATA_MODEL_NAME + " is not configured"));
			}
			bLastLoadWasMock = true;
			// the mock rows are stamped with the period that was ASKED for, so
			// stepping the month on דף הבית moves them the way real data would
			var oMockPeriod = {
				year: oRequest.beginDate.getUTCFullYear(),
				month: oRequest.beginDate.getUTCMonth() + 1
			};
			return new Promise(function (resolve) {
				// the 300ms keeps the busy indicator honest about being a fetch
				setTimeout(function () {
					resolve(_buildMockRows(oMockPeriod));
				}, 300);
			});
		}

		// metadataLoaded(true) rejects on a failed metadata load instead of
		// waiting forever for one that never arrives.
		return oModel.metadataLoaded(true).then(function () {
			return _readManagerEmployees(oModel, oRequest);
		}).then(function (aResults) {
			bLastLoadWasMock = false;
			return _mapManagerEmployees(aResults, oRequest);
		}).catch(function (oError) {
			Log.error("DataService: reading " + MANAGER_EMPLOYEES_SET + " failed", oError);
			throw oError;
		});
	}

	/**
	 * The four data-driven option lists for a set of mapped rows.
	 *
	 * @param {object[]} aRows mapped rows
	 * @returns {object} {populations, branches, units, managers}
	 */
	function _deriveFilterOptions(aRows) {
		return {
			populations: _distinct(aRows, "populationKey", "population"),
			branches: _distinct(aRows, "branchKey", "branch"),
			units: _distinct(aRows, "unitKey", "unit"),
			managers: _distinct(aRows, "managerKey", "managerName")
		};
	}

	/** Distinct {key, text} options for one pair of fields, sorted in Hebrew. */
	function _distinct(aRows, sKeyField, sTextField) {
		var oSeen = {};
		return (aRows || []).reduce(function (aOut, oRow) {
			var sKey = oRow[sKeyField];
			if (sKey && !oSeen[sKey]) {
				oSeen[sKey] = true;
				aOut.push({ key: sKey, text: oRow[sTextField] || sKey });
			}
			return aOut;
		}, []).sort(function (oA, oB) {
			return oA.text.localeCompare(oB.text, "he");
		});
	}

	/* ============================================================================
	   דף הבית - Home
	   ----------------------------------------------------------------------------
	   Three payloads, one call (getHomeData below):

	     reportStatus     - the three counters in "סטטוס הדו"ח", inline-start first,
	                        i.e. right-to-left on screen.
	     messages         - "הודעות".
	     subordinateCards - one card per entry in the user's homeCards, counted
                        off the rows of the shared ManagerEmployees call.

	   `tone` on a counter / metric is the semantic accent, not a colour: the view
	   turns it into an icon colour via formatter.toneColor and into a bar fill via
	   a data-tone attribute (css/style.css §11). It is carried in the data because
	   the frame accents the same stage differently from card to card - "ממתין
	   לאישורך" is the amber one on נוכחות כפיפים and the muted one on נוכחות עובדי
	   אגף - so it is the backend's call, not a rule the view can derive.
	   ========================================================================= */

	// Icons, and why they are matched by appearance rather than by code point.
	//
	// The Figma export gives raw SAP-icons code points, which looks like the exact
	// answer - until one of them, U+E292 for דיווחים חסרים, turns out not to exist
	// in this runtime's font at all (IconPool returns nothing and the glyph renders
	// blank). That proves the frame was authored against a later SAP-icons than the
	// 1.71 one this app runs on, so a code point does not reliably carry the same
	// drawing across the two: U+E0E2 is the frame's warning triangle but 1.71's
	// warning2 diamond, and U+E084 its clock-with-a-plus but 1.71's
	// create-entry-time page.
	//
	// So each icon is the 1.71 name whose glyph looks like what the designer drew -
	// which is what they chose it for - with the code point used only to confirm a
	// match: U+E04A really is attachment, U+E0F8 really is time-account.
	//
	// דיווחים חסרים is the one open item: the frame's pencil-with-an-x has no
	// equivalent here, and sap-icon://edit is a plain pencil. Worth raising with the
	// designer rather than leaving as a silent substitution.
	// No כל השגיאות total: the tile names the three kinds of open work and leaves
	// the summing to the reader. It went out with the שגיאה framing itself - the
	// three below are things still to be done, not errors to be counted up - which
	// is also why nothing here carries the "error" tone any more.
	var HOME_REPORT_STATUS = [
		{ key: "MISSING_REPORTS", label: "דיווחים חסרים", icon: "sap-icon://edit", tone: "warning", count: 6 },
		{ key: "MISSING_APPROVALS", label: "אישורים חסרים", icon: "sap-icon://attachment", tone: "warning", count: 3 },
		{ key: "EXCEPTIONS", label: "חריגות", icon: "sap-icon://time-account", tone: "warning", count: 1 }
	];

	// הודעות - general ones only in this phase.
	//
	// `type` is carried rather than left implicit because the tile says which kind
	// each message is, and because הודעות אישיות ("PERSONAL") join this same list in
	// phase ב', once the rule that decides who gets one is settled. Nothing here
	// carries a read / unread state: the tile does not show one.
	var HOME_MESSAGES = [
		{
			type: "GENERAL",
			subject: "מסר ההודעה מהאחראי עליך",
			body: "תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה"
		},
		{
			type: "GENERAL",
			subject: "מסר ההודעה מהאחראי עליך",
			body: "תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה"
		}
	];

	/**
	 * The four "נתוני נוכחות כפיפים" cards.
	 *
	 * The counts are gone: every metric now states WHICH stage of the approval
	 * chain it counts (`party`, as _waitingParty returns it) and WHICH slice of
	 * the manager's people it counts it over (`scope`), and the numbers are
	 * counted off the rows that came back from the one shared ManagerEmployees
	 * call - see _buildCards.
	 *
	 * The labels and the tones are left exactly as the design set them, including
	 * the two that look inconsistent and are not: "ממתין לאישורך" is the MANAGER
	 * stage on נוכחות כפיפים and the משא"ן stage on נוכחות עובדי אגף, because the
	 * two cards are read by different people. The tone follows the label.
	 *
	 * scope - the same distinction the "כפיפים" filter makes on the screen each
	 * card opens, which is why the two agree by construction (SUBORDINATE_SCOPE):
	 *   DIRECT    only the people whose own ממונה is the logged-in user
	 *   ALL       the whole subtree - a report of a report is still in the אגף
	 *   CIVILIAN  the whole subtree, non-soldier populations (SOLDIER_POPULATIONS)
	 *   SOLDIERS  the whole subtree, soldier populations
	 */
	var HOME_CARDS = {
		SUBORDINATES: {
			title: "נוכחות כפיפים",
			scope: "DIRECT",
			metrics: [
				{ label: "ממתין לאישור עובד", party: "EMPLOYEE", tone: "brand" },
				{ label: "ממתין לאישורך", party: "MANAGER", tone: "warning" },
				{ label: 'ממתין למשא"ן', party: "HR", tone: "muted" }
			]
		},
		DIVISION: {
			title: "נוכחות עובדי אגף",
			scope: "ALL",
			metrics: [
				{ label: "ממתין לאישור עובד", party: "EMPLOYEE", tone: "brand" },
				{ label: "ממתין לממונה", party: "MANAGER", tone: "warning" },
				{ label: "ממתין לאישורך", party: "HR", tone: "muted" }
			]
		},
		CIVILIAN: {
			title: 'נוכחות אמ"ש',
			scope: "CIVILIAN",
			metrics: [
				{ label: "ממתין לאישור עובד", party: "EMPLOYEE", tone: "brand" },
				{ label: "ממתין לאישורך", party: "MANAGER", tone: "warning" },
				{ label: 'ממתין למשא"ן', party: "HR", tone: "muted" }
			]
		},
		SOLDIERS: {
			title: "נוכחות חיילות",
			scope: "SOLDIERS",
			metrics: [
				{ label: "ממתין לאישור עובד", party: "EMPLOYEE", tone: "brand" },
				{ label: "ממתין לאישורך", party: "MANAGER", tone: "warning" },
				{ label: 'ממתין למשא"ן', party: "HR", tone: "muted" },
				{ label: "ממתין לשלישות", party: "DELEGATION", tone: "muted" }
			]
		}
	};

	/** The rows one card counts over. */
	function _cardRows(aRows, sScope) {
		switch (sScope) {
			case "DIRECT":
				return aRows.filter(function (oRow) { return oRow.isDirect; });
			case "CIVILIAN":
				return aRows.filter(function (oRow) { return !_isSoldierPopulation(oRow.populationKey); });
			case "SOLDIERS":
				return aRows.filter(function (oRow) { return _isSoldierPopulation(oRow.populationKey); });
			default:
				return aRows;
		}
	}

	/**
	 * The cards a user may see, counted off the rows of the shared call.
	 *
	 * @param {object[]} aRows     mapped ManagerEmployees rows
	 * @param {string[]} aCardKeys which cards this level grants (ROLE_CARDS)
	 * @returns {object[]} the דף הבית cards, in display order
	 */
	function _buildCards(aRows, aCardKeys) {
		return (aCardKeys || []).map(function (sCardKey) {
			var oCard = HOME_CARDS[sCardKey];
			if (!oCard) {
				// an unknown key is a configuration error, not a crash
				return null;
			}

			var aScoped = _cardRows(aRows || [], oCard.scope);

			return {
				key: sCardKey,
				title: oCard.title,
				updatedMinutesAgo: 0,
				metrics: oCard.metrics.map(function (oMetric) {
					return {
						label: oMetric.label,
						tone: oMetric.tone,
						count: aScoped.filter(function (oRow) {
							return oRow.handledByKey === oMetric.party;
						}).length
					};
				})
			};
		}).filter(Boolean);
	}

	/**
	 * דף הבית, assembled from the manager context.
	 *
	 * The counters in "סטטוס הדו"ח" and "הודעות" are still fixed text -
	 * neither has a service behind it yet - but everything in the second block
	 * now comes out of the rows the shared call returned.
	 *
	 * @param {object} oContext a loadManagerContext result
	 * @returns {object} the getHomeData payload
	 */
	function _buildHomeData(oContext) {
		var oUser = oContext.user;

		return {
			user: {
				displayName: oUser.displayName
			},

			// The second block of the screen. It is the AUTHORISATION that decides
			// this and nothing else: a level with no cards is עובד, and an עובד
			// sees only the top of the screen.
			showSubordinates: oUser.homeCards.length > 0,

			reportStatus: HOME_REPORT_STATUS.map(function (oCounter) {
				return {
					key: oCounter.key,
					label: oCounter.label,
					icon: oCounter.icon,
					tone: oCounter.tone,
					count: oCounter.count
				};
			}),

			messages: HOME_MESSAGES.map(function (oMessage) {
				return {
					type: oMessage.type,
					subject: oMessage.subject,
					body: oMessage.body
				};
			}),

			// "הכל" first, then the populations the manager's own people are in -
			// so the filter can never offer a value the cards have no rows for.
			populationOptions: [{ key: "ALL", text: "הכל" }]
				.concat(oContext.filterOptions.populations),

			subordinateCards: oContext.cards
		};
	}

	/* ============================================================================
	   The manager context - ONE call, shared by all three screens
	   ----------------------------------------------------------------------------
	   On entry the app asks who the user is, and - unless they are a plain עובד -
	   reads /ManagerEmployeesSet ONCE for their whole population:

	     ImManagerType = the user's authorisation level (the level IS the type)
	     Employee      = the user's own personnel number
	     ImBeginDate /
	     ImEndDate     = the active period (see _activePeriod)
	     no ImDepartment - "אוכלוסיה: הכל"

	   What comes back feeds three different things, which is the whole reason it
	   is one call and not three:

	     - the counters on דף הבית's cards            (_buildCards)
	     - the אגף / יחידה / אוכלוסיה / שם ממונה option lists on BOTH report
	       screens, so picking a filter there is instant and never waits on a
	       round trip
	     - and nothing else: the tables on those screens still load their own rows.

	   CACHING is the point, not an optimisation. The option lists must NOT move
	   while the user is working the filter bar - a list that reshuffled itself on
	   every selection would take away the value the user just picked. So the
	   result is cached per period, and the ONLY things that go back to the
	   service are a refresh (invalidateManagerContext) and a period דף הבית has
	   not asked for before.
	   ========================================================================= */

	/** cache key -> in-flight or settled Promise of a context */
	var mManagerContext = {};

	function _contextKey(iYear, iMonth, sPopulationKey) {
		return iYear + "-" + iMonth + "-" + (sPopulationKey || "ALL");
	}

	/**
	 * Assembles a context from rows that have already arrived. Split out so the
	 * עובד case - which has no rows and makes no call - produces exactly the same
	 * shape as a loaded one, and every caller can stop special-casing it.
	 */
	function _toContext(oUser, oPeriod, aRows) {
		return {
			user: oUser,
			period: oPeriod,
			rows: aRows,
			filterOptions: _deriveFilterOptions(aRows),
			cards: _buildCards(aRows, oUser.homeCards)
		};
	}

	function _loadManagerContext(oComponent, oOptions) {
		var o = oOptions || {};

		return _loadUserAuthorization(oComponent).then(function (oUser) {
			var oActive = _activePeriod();
			var oPeriod = {
				year: o.year || oActive.year,
				month: o.month || oActive.month,
				populationKey: o.populationKey || "ALL"
			};

			// עובד: no subordinates, so nothing to ask the service for. Resolving
			// with an empty context rather than skipping the call at the call site
			// keeps "what does this user see" a single decision, made here.
			if (oUser.role === ROLE.EMPLOYEE) {
				return _toContext(oUser, oPeriod, []);
			}

			var oBounds = _periodBounds(oPeriod.year, oPeriod.month);

			return getManagerReports(oComponent, {
				managerType: oUser.role,
				managerUser: oUser.userId,
				employee: oUser.pernr,
				managerName: oUser.displayName,
				beginDate: oBounds.begin,
				endDate: oBounds.end
			}).then(function (aRows) {
				// אוכלוסיה on דף הבית narrows what is already here rather than
				// re-asking: the call was made for "הכל" precisely so that stepping
				// through the populations costs nothing.
				var aScoped = oPeriod.populationKey === "ALL"
					? aRows
					: aRows.filter(function (oRow) {
						return oRow.populationKey === oPeriod.populationKey;
					});

				return _toContext(oUser, oPeriod, aScoped);
			});
		});
	}

	/* ---------------------------------------------------------------------------
	   ManagerSet - הרשאות המשתמש, the ENTRY call
	   ------------------------------------------------------------------------
	   The first thing the app asks, and the only thing that answers "who is
	   this": their name, their personnel number, their department and - through
	   the Roles navigation property - which manager roles they hold.

	     GET /ManagerSet?$expand=Roles&$filter=(UserName eq 'W04154')

	   $expand is not optional. The roles are the authorisation, and without them
	   the response says who the user is but not what they may see, which would
	   leave every screen with nothing to draw. One round trip, not two.

	   The $filter is not optional either - confirmed against the running service.

	   The response, one entry per user:

	     UserName            "W04154"       the SAP user - the key
	     PersonnelNumber     "01487698"     -> Employee on ManagerEmployeesSet
	     Name                               the display name
	     Email, Department, DepartmentLongName, Unit
	     Roles.results[]     { ManagerType: "TMGR", ManagerUser: "W04154",
	                           FunctionCaller: ... }

	   ManagerType carries exactly the values ROLE already uses (TMGR / TADM /
	   TMSA / TSLD), which is why the roles map straight onto homeCards through
	   ROLE_CARDS with nothing in between.

	   WHO is asked about - and the one open question in this file:

	   ManagerSet is filtered BY a UserName, so something has to supply one before
	   this call can be made. It is not a constant any more: _resolveLoginUser
	   below is the single seam it comes through, and it returns a Promise
	   precisely so the answer may be a service read.

	   OPEN: the service carries a further entity that answers "who am I" - its
	   name is not confirmed yet. Once it is, _resolveLoginUser reads it and
	   LOGIN_USER_SEED goes away; nothing else in the file has to change, because
	   every caller already waits on the Promise.

	   What is NOT open: everything DOWNSTREAM takes the user from this call's
	   RESPONSE and never from whatever seeded the filter - ImManagerUser on every
	   ManagerEmployeesSet read, the sender of a תזכורת, the greeting on דף הבית.
	   The response is the authority; the seed only decides who is asked about.

	   ?user=XXXXX overrides the seam for trying another user against a real
	   service. Nothing in the app sets it.

	   Asked once per session and cached: every screen goes through
	   loadManagerContext, which waits on this, so דף הבית makes the call on
	   entry and each manager screen reuses the answer instead of re-asking. A
	   FAILED call is not cached - the next screen is allowed to try again.
	   ------------------------------------------------------------------------ */

	/**
	 * The order roles are ranked in when a user holds several, WIDEST AUTHORITY
	 * FIRST. The winner becomes `role`.
	 *
	 * What `role` is, and is not:
	 *
	 *   it IS   the ImManagerType of the one shared ManagerEmployees call behind
	 *           loadManagerContext. That call exists to be counted and sliced by
	 *           every דף הבית card at once, so it has to ask for the widest
	 *           population the user is allowed to see - which is what this order
	 *           picks. It is also the fallback for a manager screen opened with
	 *           no card at all (a bookmark, a direct URL).
	 *
	 *   it is NOT what a manager screen asks for once it HAS been opened from a
	 *           card. There the card decides: כפיפים sends TMGR and returns this
	 *           manager's own people, אמ"ש sends TMSA and returns that
	 *           population - see getManagerType and ManagerReports#_onRouteMatched.
	 *
	 * The CARDS do not go through this either: they are the union of every role's
	 * cards (see _toAuthorization), so a user who is both מנהל and אמ"ש sees both
	 * cards and chooses between them by pressing one.
	 *
	 * Worth confirming with the backend: if Roles comes back in a meaningful
	 * order, the first entry is a better answer than a precedence list here.
	 */
	var ROLE_PRECEDENCE = [ROLE.HR, ROLE.CIVILIAN, ROLE.SUPPLY, ROLE.MANAGER];

	/** ?user=W04154 - a development aid: ask the entry call about somebody else. */
	function _userOverride() {
		var aMatch = /[?&]user=([A-Za-z0-9_]+)/.exec(window.location.search);
		return aMatch ? aMatch[1].toUpperCase() : null;
	}

	/**
	 * The last resort of _resolveLoginUser, and the only user name still written
	 * down anywhere. It is a SEED for the entry call's filter, not the app's idea
	 * of who is logged in - that comes back from the call it seeds.
	 *
	 * It goes away as soon as the "who am I" entity is named; see the OPEN note
	 * above.
	 */
	var LOGIN_USER_SEED = "W04154";

	/**
	 * Who the entry call asks about. The ONE place the question is answered, in
	 * the order the answers are trusted:
	 *
	 *   1. ?user=        a developer said so explicitly
	 *   2. sap.ushell    the launchpad knows, and inside it this is the real one
	 *   3. LOGIN_USER_SEED
	 *
	 * A Promise rather than a string, so that step 3 can be replaced by a service
	 * read without touching a single caller.
	 *
	 * @returns {Promise<string>} the SAP user to filter ManagerSet by
	 */
	function _resolveLoginUser() {
		var sOverride = _userOverride();
		if (sOverride) {
			return Promise.resolve(sOverride);
		}

		// Inside the Fiori launchpad the shell already holds the logged-in user,
		// and asking it costs nothing. Standalone there is no sap.ushell at all,
		// which is why every step of this is guarded rather than assumed.
		try {
			var oContainer = window.sap && window.sap.ushell && window.sap.ushell.Container;
			var oUserInfo = oContainer && oContainer.getService && oContainer.getService("UserInfo");
			var sShellUser = oUserInfo && oUserInfo.getId && oUserInfo.getId();
			if (sShellUser) {
				return Promise.resolve(sShellUser.toUpperCase());
			}
		} catch (oErr) {
			Log.warning("DataService: sap.ushell UserInfo is not available", oErr);
		}

		Log.warning("DataService: falling back to the seeded login user "
			+ LOGIN_USER_SEED + " - no launchpad and no ?user=");
		return Promise.resolve(LOGIN_USER_SEED);
	}

	/**
	 * Reads the entry call, filtered by the user _resolveLoginUser named.
	 *
	 * @param {sap.ui.model.odata.v2.ODataModel} oModel the service model
	 * @param {string} sUserName the user to ask about
	 * @returns {Promise<object[]>} the ManagerSet entries, Roles expanded
	 */
	function _readManager(oModel, sUserName) {
		return new Promise(function (resolve, reject) {
			oModel.read(MANAGER_SET, {
				urlParameters: { "$expand": "Roles" },
				filters: [new Filter("UserName", FilterOperator.EQ, sUserName)],
				success: function (oData) {
					resolve((oData && oData.results) || []);
				},
				error: function (oError) {
					reject(_toServiceError(oError, "טעינת הרשאות המשתמש נכשלה"));
				}
			});
		});
	}

	/**
	 * One ManagerSet entry -> the user shape the whole app reads.
	 *
	 * A user with no roles at all is an עובד: EMPL is not a role the service
	 * sends, it is the absence of every other one, and it is what takes the
	 * subordinate block off דף הבית.
	 *
	 * @param {object} oEntry a ManagerSet result, Roles expanded
	 * @returns {object} {userId, pernr, displayName, role, roles, homeCards,
	 *   email, department, departmentName, unit}
	 */
	function _toAuthorization(oEntry) {
		var o = oEntry || {};
		var aRoles = _distinctRoleTypes(o);
		var aCards = [];

		aRoles.forEach(function (sRole) {
			(ROLE_CARDS[sRole] || []).forEach(function (sCard) {
				if (aCards.indexOf(sCard) === -1) {
					aCards.push(sCard);
				}
			});
		});

		return {
			userId: o.UserName || "",
			pernr: o.PersonnelNumber || "",
			// Name is empty on some entries; the user name is a poor greeting but
			// an honest one, and better than greeting nobody.
			displayName: o.Name || o.UserName || "",
			role: _primaryRole(aRoles),
			roles: aRoles,
			homeCards: aCards,
			email: o.Email || "",
			department: o.Department || "",
			departmentName: o.DepartmentLongName || "",
			unit: o.Unit || ""
		};
	}

	/** The ManagerType values on an entry's expanded Roles, de-duplicated. */
	function _distinctRoleTypes(oEntry) {
		var oRoles = (oEntry && oEntry.Roles) || null;
		var aResults = (oRoles && oRoles.results) || [];

		// Roles came back as a link instead of as data, i.e. the $expand did not
		// take. Worth saying out loud: with no roles the user reads as an עובד and
		// the screen quietly loses its cards, which looks like an authorisation
		// decision rather than like a request that was built wrong.
		if (oRoles && !oRoles.results) {
			Log.warning("DataService: " + MANAGER_SET + " returned Roles unexpanded"
				+ " - the user will be treated as having no manager roles");
		}

		return aResults.reduce(function (aTypes, oRole) {
			var sType = oRole && oRole.ManagerType;
			if (sType && aTypes.indexOf(sType) === -1) {
				aTypes.push(sType);
			}
			return aTypes;
		}, []);
	}

	/** The one role the single-valued callers get - see ROLE_PRECEDENCE. */
	function _primaryRole(aRoles) {
		var sWinner = ROLE_PRECEDENCE.filter(function (sRole) {
			return aRoles.indexOf(sRole) !== -1;
		})[0];

		return sWinner || ROLE.EMPLOYEE;
	}

	var pUserAuthorization = null;

	/**
	 * The entry call, once per session. On a mock host it resolves with
	 * MOCK_USER (honouring ?role=) without asking anything, exactly as the reads
	 * do; deployed, a failure is a failure and the screens report it.
	 */
	function _loadUserAuthorization(oComponent) {
		if (pUserAuthorization) {
			return pUserAuthorization;
		}

		var oModel = oComponent && oComponent.getModel(ODATA_MODEL_NAME);
		var pLoad;

		if (_isMockEnvironment() || !oModel) {
			if (!oModel && !_isMockEnvironment()) {
				return Promise.reject(new Error("DataService: model "
					+ ODATA_MODEL_NAME + " is not configured"));
			}
			pLoad = Promise.resolve(_mockAuthorization());
		} else {
			// The user is resolved FIRST and the metadata loaded alongside it:
			// the two do not depend on each other, and the call below needs both.
			pLoad = Promise.all([
				_resolveLoginUser(),
				oModel.metadataLoaded(true)
			]).then(function (aReady) {
				var sUserName = aReady[0];
				return _readManager(oModel, sUserName).then(function (aResults) {
					if (!aResults.length) {
						// Through the gateway, but with no entry in this application
						throw new Error("המשתמש " + sUserName + " אינו מוגדר במערכת הנוכחות");
					}
					// The RESPONSE is what the app goes on to use - not sUserName,
					// which only decided who was asked about.
					return _toAuthorization(aResults[0]);
				});
			});
		}

		pUserAuthorization = pLoad.then(function (oUser) {
			// written to the module so the synchronous getCurrentUser() callers -
			// the filter defaults on דוחות נוכחות - see the real user
			oCurrentUser = oUser;
			Log.info("DataService: user " + oUser.userId
				+ " (" + oUser.displayName + ") at level " + oUser.role
				+ " [" + (oUser.roles || [oUser.role]).join(", ") + "]");
			return oUser;
		}).catch(function (oError) {
			// a failed entry call must not become the session's answer
			pUserAuthorization = null;
			Log.error("DataService: reading " + MANAGER_SET + " failed", oError);
			throw oError;
		});

		return pUserAuthorization;
	}

	/* ---------------------------------------------------------------------------
	   שליחת תזכורת - which month a reminder is about
	   ------------------------------------------------------------------------
	   A reminder is always about ONE month, and never about the month the sender
	   is standing in the middle of: up to the 10th the month that just ended is
	   still being closed, so that is the one being chased; from the 11th it is
	   settled and the current month is the open one.

	   The 10th is a business rule, not a calendar fact - it is the day the
	   previous month stops accepting corrections. It lives here, with the rest of
	   the text the backend will eventually return, and not in the screen.
	   ------------------------------------------------------------------------ */
	// _activePeriod, which used to live here under the name _reminderPeriod, has
	// moved up to the top of the file: the same rule now decides which month דף
	// הבית opens on and which month the shared ManagerEmployees call asks for, so
	// it can no longer belong to the reminder.

	/** The subject + body the dialog opens on, for one period. */
	function _buildReminderTemplate(oPeriod) {
		var sMonth = oPeriod.name + " " + oPeriod.year;
		var sMonthKey = (oPeriod.month < 10 ? "0" : "") + oPeriod.month;

		return {
			periodMonth: oPeriod.month,
			periodYear: oPeriod.year,
			periodLabel: sMonthKey + "/" + oPeriod.year,
			subject: "תזכורת לסגירת דיווח שעות לחודש " + sMonth,
			body: [
				"שלום רב,",
				"",
				"דיווח השעות לחודש " + sMonth + " טרם נסגר.",
				"נא להיכנס למערכת הנוכחות, להשלים את הדיווח ולאשר אותו בהקדם.",
				"",
				"תודה,",
				"מערכת דיווח הנוכחות"
			].join("\n")
		};
	}

	return {

		STATUS: STATUS,

		/** The five authorisation levels: EMPLOYEE / MANAGER / HR / CIVILIAN / SUPPLY. */
		ROLE: ROLE,

		/**
		 * The logged-in user, synchronously - {userId, pernr, displayName, role,
		 * homeCards}. Before getUserAuthorization has answered this is the mock
		 * user; afterwards it is whatever the service said.
		 *
		 * Anything that can wait should wait: getUserAuthorization() is the
		 * authoritative answer. This exists for the handful of places that run
		 * before it resolves - the filter defaults on דוחות נוכחות - and they
		 * re-apply themselves once the context arrives.
		 */
		getCurrentUser: function () {
			return _currentUser();
		},

		/**
		 * הרשאות המשתמש - the ManagerSet entry call, once per session.
		 *
		 * Every screen already waits on this through loadManagerContext, so it is
		 * here for a caller that wants the user and nothing else. Calling it twice
		 * costs one request: the promise is cached (a failed one is not).
		 *
		 * @param {sap.ui.core.UIComponent} oComponent the owner component (holds the model)
		 * @returns {Promise<object>} {userId, pernr, displayName, role, roles,
		 *   homeCards, email, department, departmentName, unit}
		 */
		getUserAuthorization: function (oComponent) {
			return _loadUserAuthorization(oComponent);
		},

		/**
		 * Which month the app is working on: up to the 10th the month that just
		 * ended, from the 11th the current one. דף הבית opens on it, the shared
		 * ManagerEmployees call asks for it and שליחת תזכורת names it.
		 *
		 * @param {Date} [oNow] the moment to derive it from (default: now)
		 * @returns {{month: int, year: int, name: string}} month is 1..12
		 */
		getActivePeriod: function (oNow) {
			return _activePeriod(oNow);
		},

		/**
		 * The shared manager context - see the block comment above
		 * _loadManagerContext. Cached per period, so every screen after the first
		 * gets it for free.
		 *
		 * @param {sap.ui.core.UIComponent} oComponent the owner component
		 * @param {object} [oOptions] {int year, int month, string populationKey} -
		 *   all optional; the default is the active period over all populations,
		 *   which is the one every screen but דף הבית's month stepper wants
		 * @returns {Promise<object>} {user, period, rows, filterOptions, cards}
		 */
		loadManagerContext: function (oComponent, oOptions) {
			var o = oOptions || {};
			var oActive = _activePeriod();
			var sKey = _contextKey(o.year || oActive.year, o.month || oActive.month, o.populationKey);

			if (!mManagerContext[sKey]) {
				mManagerContext[sKey] = _loadManagerContext(oComponent, o).catch(function (oError) {
					// a failed load must not be cached as the answer - the next
					// attempt has to be allowed to go out again
					delete mManagerContext[sKey];
					throw oError;
				});
			}
			return mManagerContext[sKey];
		},

		/**
		 * Drops the cached context, so the next loadManagerContext goes back to the
		 * service. This is what "רענון" means on all three screens - and it is the
		 * ONLY thing that rebuilds the filter option lists, which is why changing a
		 * filter cannot disturb them.
		 */
		invalidateManagerContext: function () {
			mManagerContext = {};
		},

		/**
		 * Default status tab + default handling party for a given level.
		 * Falls back to the מנהל ישיר defaults for an unknown one.
		 */
		getRoleDefaults: function (sRole) {
			return ROLE_DEFAULTS[sRole] || ROLE_DEFAULTS[ROLE.MANAGER];
		},

		/**
		 * Static option lists used to populate the filter drop-downs.
		 * Replace with values coming from your backend if they are dynamic.
		 */
		getFilterOptions: function () {
			return {
				years: (function () {
					var iCur = new Date().getFullYear();
					var a = [];
					for (var y = iCur; y >= iCur - 4; y--) {
						a.push({ key: String(y), text: String(y) });
					}
					return a;
				})(),
				months: MONTH_NAMES.map(function (sName, i) {
					return { key: String(i + 1), text: sName };
				}),
				populations: aPopulations,
				branches: aBranches,
				units: aUnits,
				managers: aManagers,
				handlingParties: aHandlingParties,
				subordinateScopes: aSubordinateScopes
			};
		},

		/** ImManagerType values, keyed by the דף הבית card that opens the screen. */
		MANAGER_TYPE: MANAGER_TYPE,

		/**
		 * The name of the OData model, shared with Component.js so the name of the
		 * service lives in one place.
		 */
		ODATA_MODEL_NAME: ODATA_MODEL_NAME,

		/**
		 * ImManagerType for a דף הבית card key (SUBORDINATES / DIVISION / CIVILIAN
		 * / SOLDIERS). An unknown or missing card - a direct entry into the screen
		 * with no card behind it - reads as מנהל ישיר.
		 *
		 * @param {string} sCardKey card key, or "" when the screen was opened directly
		 * @returns {string} TMGR | TADM | TMSA | TSLD
		 */
		getManagerType: function (sCardKey) {
			return MANAGER_TYPE[sCardKey] || DEFAULT_MANAGER_TYPE;
		},

		/**
		 * The "כפיפים" filter a דף הבית card opens דוחות נוכחות on: נוכחות כפיפים
		 * lands on "ישירים בלבד", every other card on "כל הכפיפים" - see
		 * SUBORDINATE_SCOPE.
		 *
		 * @param {string} sCardKey card key, or "" when the screen was opened directly
		 * @returns {string} DIRECT | ALL
		 */
		getSubordinateScope: function (sCardKey) {
			return SUBORDINATE_SCOPE[sCardKey] || DEFAULT_SUBORDINATE_SCOPE;
		},

		/**
		 * Whether the rows handed out by the LAST getManagerReports call were mock.
		 * The screen tells the user when they are, so demo data is never mistaken
		 * for the real thing.
		 *
		 * @returns {boolean} true when the last load fell back to (or was forced to) mock
		 */
		isLastLoadMock: function () {
			return bLastLoadWasMock;
		},

		/**
		 * Whether this environment works against mock data instead of the service:
		 * localhost, or ?mock=true anywhere. Component.js asks this before it builds
		 * the OData model, so in mock mode the service is never even contacted.
		 *
		 * @returns {boolean} true when nothing here should talk to the backend
		 */
		isMockEnvironment: function () {
			return _isMockEnvironment();
		},

		/**
		 * דוחות נוכחות באחריות ממונה - the rows of the table.
		 *
		 * Reads /ManagerEmployeesSet off the ZHR_TM_ATTENDANCE_SYSTEM_SRV_N model
		 * and maps it onto the row shape documented at the top of this file - unless
		 * this is a mock environment (localhost / ?mock=true), where it resolves with
		 * the mock rows without contacting anything. A read that DOES go out and
		 * fails rejects, so a broken backend is never papered over with demo data.
		 *
		 * @param {sap.ui.core.UIComponent} oComponent the owner component (holds the model)
		 * @param {object} [oParams] the request
		 *   {string} managerType TMGR | TADM | TMSA | TSLD  (default TMGR)
		 *   {string} managerUser SAP user           (default the current user)
		 *   {Date}   beginDate   start of the period (default: first of this month)
		 *   {Date}   endDate     end of the period   (default: last of this month)
		 *   {string} department  optional ImDepartment
		 *   {boolean} oldReports ממתינים לאישור מחודשים קודמים - sent as
		 *                        ImOldReports, and only when true
		 *   {string} reportType  stamped onto every row (default ATTENDANCE); the
		 *                        screen no longer offers a סוג דוח filter over it
		 * @returns {Promise<object[]>} the rows
		 */
		getManagerReports: getManagerReports,

		/**
		 * The filter drop-downs that depend on the DATA rather than on a fixed
		 * domain: אוכלוסייה / אנף / יחידה / שם מנהל ישיר, distilled from a set of
		 * mapped rows.
		 *
		 * The screens do NOT call this - they read `filterOptions` off the shared
		 * manager context, which is the same thing computed once for everybody.
		 * It stays exported for a caller that has rows of its own to describe.
		 *
		 * @param {object[]} aRows mapped rows
		 * @returns {object} {populations, branches, units, managers} option lists
		 */
		deriveFilterOptions: _deriveFilterOptions,

		/**
		 * Everything דף הבית shows, in one round trip.
		 *
		 * The second block - the cards and their counters - is counted off the
		 * shared manager context, so the screen is drawing the SAME rows the two
		 * report screens filter. The month and the אוכלוסיה filter are part of the
		 * request: a month the context has not been loaded for goes out to the
		 * service, a population narrows the rows that are already here.
		 *
		 * "סטטוס הדו"ח" and "הודעות" are still fixed - there is no service
		 * behind either yet. They are the remaining backend calls on this screen.
		 *
		 * @param {sap.ui.core.UIComponent} oComponent the owner component
		 * @param {object} oParams
		 *   {int}    year          e.g. 2025
		 *   {int}    month         1..12
		 *   {string} populationKey "ALL" | MOD | EXTERNAL | SOLDIER | NATIONAL_SERVICE
		 *
		 * @returns {Promise<object>} resolving with:
		 * {
		 *   user:             { displayName: string },
		 *   showSubordinates: bool,      // draw the second block at all
		 *   reportStatus:     [{ key, label, icon, tone, count }],
		 *   messages:         [{ type, subject, body }],   // type: GENERAL | PERSONAL
		 *   populationOptions:[{ key, text }],
		 *   subordinateCards: [{
		 *       key, title, updatedMinutesAgo,
		 *       metrics: [{ label, count, tone }]   // tone: brand|warning|muted|error|success
		 *   }]
		 * }
		 *
		 * The screen derives the rest: the bar widths are each metric's share of its
		 * own card, and the greeting / "חדש" / "עודכן מלפני N דקות" wording comes
		 * from i18n. Return counts and tones - not text, not percentages.
		 */
		getHomeData: function (oComponent, oParams) {
			return this.loadManagerContext(oComponent, oParams).then(_buildHomeData);
		},

		/**
		 * ============ PLUG YOUR BACKEND CALL IN HERE - שליחת תזכורת ============
		 *
		 * The text שליחת תזכורת opens with. It is deliberately the SERVICE's text
		 * and not the screen's: the wording of an outgoing message is content, it
		 * gets rewritten by people who do not deploy the UI, and the month it
		 * names follows a closing rule (_activePeriod) that belongs beside the
		 * rest of the attendance logic. The dialog only lets the sender edit it.
		 *
		 * The screen asks once per entry (_onRouteMatched) and re-reads the answer
		 * every time the dialog opens, so an edit that was not sent is dropped.
		 *
		 * @param {object} [oParams] the sender's context, for a backend that
		 *   personalises the text: {string} managerUser, {string} managerType
		 * @returns {Promise<object>} {periodMonth, periodYear, periodLabel,
		 *   subject, body} - periodLabel is "MM/YYYY", and the two period fields
		 *   travel back in the payload so what was sent is never re-derived from
		 *   the clock of the machine that sent it.
		 */
		getReminderTemplate: function (oParams) {
			var oTemplate = _buildReminderTemplate(_activePeriod());
			Log.debug("DataService: reminder template (mock)", JSON.stringify(oParams || {}));
			return new Promise(function (resolve) {
				setTimeout(function () {
					resolve(oTemplate);
				}, 300);
			});
		},

		/**
		 * Sends the reminder: POST /MailSendingSet on
		 * ZHR_TM_ATTENDANCE_SYSTEM_SRV_N.
		 *
		 * The entity takes three strings and the payload carries more than that -
		 * the period and the sender's context are here because the SCREEN needs
		 * them (they are what the text names, and what a later backend may want to
		 * personalise on), not because the entity does. They are deliberately not
		 * invented into properties the service has not declared; the month reaches
		 * the recipient inside Subject and Body, where the template put it.
		 *
		 * Recipients travel as one semicolon-joined string - see
		 * RECIPIENT_SEPARATOR.
		 *
		 * On a mock host nothing is posted and the promise resolves, the same way
		 * the reads resolve with mock rows: no mail is ever sent from a machine
		 * that has no backend. A rejection carries a message fit to show - see
		 * _serviceErrorMessage - and the screen puts it in a dialog.
		 *
		 * @param {sap.ui.core.UIComponent} oComponent the owner component (holds the model)
		 * @param {object} oPayload
		 *   {string[]} to          recipient addresses, already de-duplicated
		 *   {string}   subject     as edited in the dialog -> Subject
		 *   {string}   body        as edited in the dialog -> Body
		 *   {int}      periodMonth 1..12 - the month being chased
		 *   {int}      periodYear
		 *   {string}   managerUser the sender (ImManagerUser)
		 *   {string}   managerType the population the screen was opened for
		 * @returns {Promise} resolves when the service has accepted the mail
		 */
		sendReminder: function (oComponent, oPayload) {
			var o = oPayload || {};
			var oModel = oComponent && oComponent.getModel(ODATA_MODEL_NAME);
			var oEntry = {
				Subject: o.subject || "",
				Body: o.body || "",
				Recipients: (o.to || []).join(RECIPIENT_SEPARATOR)
			};

			if (_isMockEnvironment() || !oModel) {
				if (!oModel && !_isMockEnvironment()) {
					return Promise.reject(new Error("DataService: model "
						+ ODATA_MODEL_NAME + " is not configured"));
				}
				Log.info("DataService: sendReminder (mock)", JSON.stringify(oEntry));
				return new Promise(function (resolve) {
					setTimeout(resolve, 300);
				});
			}

			return oModel.metadataLoaded(true).then(function () {
				return _createMailSending(oModel, oEntry);
			}).catch(function (oError) {
				Log.error("DataService: posting " + MAIL_SENDING_SET + " failed", oError);
				// metadataLoaded rejects with something raw; _createMailSending has
				// already wrapped its own, and wrapping a wrapped Error is a no-op
				// that keeps its message.
				throw oError instanceof Error
					? oError
					: _toServiceError(oError, "שליחת התזכורת נכשלה");
			});
		}
	};
});
