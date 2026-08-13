sap.ui.define([
	"sap/ui/model/Filter",
	"sap/ui/model/FilterOperator",
	"sap/base/Log"
], function (Filter, FilterOperator, Log) {
	"use strict";

	/* =========================================================================
	 * DataService
	 * -------------------------------------------------------------------------
	 * This is the SINGLE place the app talks to a data source.
	 *
	 * `getManagerReports()` now reads the real service (see the OData section
	 * below) and falls back to the mock rows when the service is not reachable -
	 * which is what happens on this development machine, where there is no
	 * NetWeaver behind localhost:8080. Everything else here is still mock.
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
		role: "MANAGER", // MANAGER | HR

		// The SAP user name (SY-UNAME), sent to the service as ImManagerUser.
		// TODO: read it from the launchpad instead of hardcoding it -
		//   sap.ushell.Container.getService("UserInfo").getId()
		// which is only available inside the FLP; keep this value as the
		// standalone-development fallback.
		userId: "MOSHEC",

		// --- דף הבית -----------------------------------------------------------
		// The name the home screen greets, which is the person rather than the
		// manager record above.
		displayName: "ישראל ישראלי",

		// Which "נתוני נוכחות כפיפים" cards this user may see, in display order.
		// Deliberately a list and not a role lookup: this is an authorisation
		// RESULT, which is what a backend returns - a ממונה, a משא"ן user and a
		// שלישות user each get a different subset, and some people hold more than
		// one of those hats at once. Empty means the user only sees the top block
		// of the screen, which is the state every plain employee is in - try it by
		// emptying this array.
		homeCards: ["SUBORDINATES", "DIVISION", "CIVILIAN", "SOLDIERS"]
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

	/* ============================================================================
	   OData - ZHR_TM_ATTENDANCE_SYSTEM_SRV_N
	   ----------------------------------------------------------------------------
	   The real source of דוחות נוכחות באחריות ממונה.

	   Model name:  ZHR_TM_ATTENDANCE_SYSTEM_SRV_N
	   Service URI: manifest.json > sap.app/dataSources, under that same name
	   EntitySet:   /ManagerEmployeesSet   (EntityType ManagerEmployees, key Pernr)

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
		var oNow = new Date();
		var iYear = oNow.getFullYear();
		var iMonth = oNow.getMonth();

		return {
			managerType: o.managerType || DEFAULT_MANAGER_TYPE,
			managerUser: o.managerUser || CURRENT_USER.userId,
			// default period: the current month, first day to last day
			beginDate: o.beginDate || new Date(Date.UTC(iYear, iMonth, 1)),
			// day 0 of the next month is the last day of this one
			endDate: o.endDate || new Date(Date.UTC(iYear, iMonth + 1, 0)),
			department: o.department || "",
			reportType: o.reportType || "ATTENDANCE"
		};
	}

	/** The mandatory input parameters, as $filter terms. */
	function _buildRequestFilters(oParams) {
		var aFilters = [
			new Filter("ImBeginDate", FilterOperator.EQ, oParams.beginDate),
			new Filter("ImEndDate", FilterOperator.EQ, oParams.endDate),
			new Filter("ImManagerUser", FilterOperator.EQ, oParams.managerUser),
			new Filter("ImManagerType", FilterOperator.EQ, oParams.managerType)
		];
		// Optional - sent only when the caller narrows to one department, so an
		// empty string never reaches the backend as a real restriction.
		if (oParams.department) {
			aFilters.push(new Filter("ImDepartment", FilterOperator.EQ, oParams.department));
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

	/** "00002251424" -> "2251424" for display; the raw value stays in employeeId. */
	function _trimPernr(sPernr) {
		return String(sPernr || "").replace(/^0+/, "");
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

		return (aResults || []).map(function (oEntry) {
			// אוכלוסייה: DescGrp2 is the only descriptive group the entity carries,
			// and it is a text with no code beside it - so it is its own filter key.
			var sPopulation = oEntry.DescGrp2 || "";

			return {
				employeeId: oEntry.Pernr,
				employeeNumber: _trimPernr(oEntry.Pernr),
				employeeName: _fullName(oEntry),

				population: sPopulation,
				populationKey: sPopulation,

				// אנף / יחידה - code as the filter key, name as the display text
				branch: oEntry.DepartmentName || oEntry.Department || "",
				branchKey: oEntry.Department || "",
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

				// כפיפים: the service already returns exactly the population
				// ImManagerType asked for, so a client-side "ישירים בלבד" gate
				// would filter a second time on something it cannot see. Every
				// row therefore counts as direct.
				isDirect: true,

				// --- from the request, not from the response ---
				approvalMonth: (iMonth < 10 ? "0" + iMonth : String(iMonth)) + "/" + iYear,
				approvalMonthKey: String(iMonth),
				approvalYearKey: String(iYear),
				reportType: oParams.reportType,

				// --- not in the service yet ---
				extraMonths: 0,
				status: "",
				handledByKey: "",
				processStep: 0,
				processTotal: null,
				stepStates: []
			};
		});
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

	     reportStatus     - the four counters in "סטטוס הדו"ח", inline-start first,
	                        i.e. right-to-left on screen.
	     messages         - "הודעות אישיות".
	     subordinateCards - one card per entry in CURRENT_USER.homeCards.

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
	var HOME_REPORT_STATUS = [
		{ key: "ALL_ERRORS", label: "כל השגיאות", icon: "sap-icon://alert", tone: "error", count: 10 },
		{ key: "MISSING_REPORTS", label: "דיווחים חסרים", icon: "sap-icon://edit", tone: "warning", count: 6 },
		{ key: "MISSING_ATTACHMENTS", label: "צרופות חסרות", icon: "sap-icon://attachment", tone: "warning", count: 3 },
		{ key: "EXCEPTIONS", label: "חריגות", icon: "sap-icon://time-account", tone: "warning", count: 1 }
	];

	var HOME_MESSAGES = [
		{
			isNew: true,
			subject: "מסר ההודעה מהאחראי עליך",
			body: "תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה"
		},
		{
			isNew: false,
			subject: "מסר ההודעה מהאחראי עליך",
			body: "תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה תוכן ההודעה"
		}
	];

	var HOME_CARDS = {
		SUBORDINATES: {
			title: "נוכחות כפיפים",
			metrics: [
				{ label: "ממתין לאישור עובד", count: 5, tone: "brand" },
				{ label: "ממתין לאישורך", count: 8, tone: "warning" },
				{ label: 'ממתין למשא"ן', count: 2, tone: "muted" }
			]
		},
		DIVISION: {
			title: "נוכחות עובדי אגף",
			metrics: [
				{ label: "ממתין לאישור עובד", count: 32, tone: "brand" },
				{ label: "ממתין לממונה", count: 2, tone: "warning" },
				{ label: "ממתין לאישורך", count: 20, tone: "muted" }
			]
		},
		CIVILIAN: {
			title: 'נוכחות אמ"ש',
			metrics: [
				{ label: "ממתין לאישור עובד", count: 302, tone: "brand" },
				{ label: "ממתין לאישורך", count: 8, tone: "warning" },
				{ label: 'ממתין למשא"ן', count: 2, tone: "muted" }
			]
		},
		SOLDIERS: {
			title: "נוכחות חיילות",
			metrics: [
				{ label: "ממתין לאישור עובד", count: 5, tone: "brand" },
				{ label: "ממתין לאישורך", count: 8, tone: "warning" },
				{ label: 'ממתין למשא"ן', count: 2, tone: "muted" },
				{ label: "ממתין לשלישות", count: 1, tone: "muted" }
			]
		}
	};

	/**
	 * How stale the counters are, in minutes - the "עודכן מלפני 5 דקות" line.
	 * A real backend reports the age of its own aggregate here.
	 */
	var HOME_UPDATED_MINUTES_AGO = 5;

	/**
	 * Mock only: a small, deterministic nudge to the counters so that stepping the
	 * month or switching אוכלוסיה visibly does something. A real backend filters on
	 * these two parameters instead, and this whole function goes away with the rest
	 * of the mock.
	 */
	function _homeMockShift(oParams) {
		// The default view - this month, all populations - returns the counts
		// exactly as the design specifies them, so the screen can be compared with
		// the frame without decoding a mock offset first.
		var oNow = new Date();
		var bDefault = oParams.year === oNow.getFullYear()
			&& oParams.month === oNow.getMonth() + 1
			&& (!oParams.populationKey || oParams.populationKey === "ALL");
		if (bDefault) {
			return 0;
		}

		var sSeed = String(oParams.year || 0) + "-" + String(oParams.month || 0) + "-" + String(oParams.populationKey || "");
		var iHash = 0;
		for (var i = 0; i < sSeed.length; i++) {
			iHash += sSeed.charCodeAt(i);
		}
		return (iHash % 5) - 2; // -2 .. +2
	}

	function _shiftCount(iCount, iShift) {
		return Math.max(0, iCount + iShift);
	}

	function _buildHomeData(oParams) {
		var iShift = _homeMockShift(oParams);

		return {
			user: {
				displayName: CURRENT_USER.displayName
			},

			// The second block of the screen. Nothing else in the app decides this.
			showSubordinates: CURRENT_USER.homeCards.length > 0,

			reportStatus: HOME_REPORT_STATUS.map(function (oCounter) {
				return {
					key: oCounter.key,
					label: oCounter.label,
					icon: oCounter.icon,
					tone: oCounter.tone,
					count: _shiftCount(oCounter.count, iShift)
				};
			}),

			messages: HOME_MESSAGES.map(function (oMessage) {
				return {
					isNew: oMessage.isNew,
					subject: oMessage.subject,
					body: oMessage.body
				};
			}),

			// "הכל" first, then the same four populations the report screens filter on.
			populationOptions: [{ key: "ALL", text: "הכל" }].concat(aPopulations.map(function (oPop) {
				return { key: oPop.key, text: oPop.text };
			})),

			subordinateCards: CURRENT_USER.homeCards.map(function (sCardKey) {
				var oCard = HOME_CARDS[sCardKey];
				if (!oCard) {
					return null;
				}
				return {
					key: sCardKey,
					title: oCard.title,
					updatedMinutesAgo: HOME_UPDATED_MINUTES_AGO,
					metrics: oCard.metrics.map(function (oMetric) {
						return {
							label: oMetric.label,
							tone: oMetric.tone,
							count: _shiftCount(oMetric.count, iShift)
						};
					})
				};
			}).filter(function (oCard) {
				// An unknown key in homeCards is a configuration error, not a crash.
				return !!oCard;
			})
		};
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
		 *   {string} reportType  stamped onto every row, for the סוג דוח filter
		 * @returns {Promise<object[]>} the rows
		 */
		getManagerReports: function (oComponent, oParams) {
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
				return new Promise(function (resolve) {
					// the 300ms keeps the busy indicator honest about being a fetch
					setTimeout(function () {
						resolve(_buildMockRows());
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
		},

		/**
		 * The filter drop-downs that depend on the DATA rather than on a fixed
		 * list: אוכלוסייה / אנף / יחידה / שם ממונה. The static lists in
		 * getFilterOptions() describe the mock, so once real rows arrive the
		 * screen replaces those four with what actually came back.
		 *
		 * @param {object[]} aRows mapped rows
		 * @returns {object} {populations, branches, units, managers} option lists
		 */
		deriveFilterOptions: function (aRows) {
			return {
				populations: _distinct(aRows, "populationKey", "population"),
				branches: _distinct(aRows, "branchKey", "branch"),
				units: _distinct(aRows, "unitKey", "unit"),
				managers: _distinct(aRows, "managerKey", "managerName")
			};
		},

		/**
		 * ============ PLUG YOUR BACKEND CALL IN HERE - דף הבית ============
		 *
		 * Everything דף הבית shows, in one round trip. Called again - not filtered
		 * client-side - whenever the month or the אוכלוסיה filter changes, so the
		 * backend does the aggregating.
		 *
		 * @param {object} oParams
		 *   {int}    year          e.g. 2025
		 *   {int}    month         1..12
		 *   {string} populationKey "ALL" | MOD | EXTERNAL | SOLDIER | NATIONAL
		 *
		 * @returns {Promise<object>} resolving with:
		 * {
		 *   user:             { displayName: string },
		 *   showSubordinates: bool,      // draw the second block at all
		 *   reportStatus:     [{ key, label, icon, tone, count }],
		 *   messages:         [{ isNew, subject, body }],
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
		getHomeData: function (oParams) {
			var o = oParams || {};
			return new Promise(function (resolve) {
				setTimeout(function () {
					resolve(_buildHomeData(o));
				}, 300);
			});
		}
	};
});
