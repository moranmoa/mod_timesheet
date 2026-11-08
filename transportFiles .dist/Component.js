sap.ui.define([
	"sap/ui/core/UIComponent",
	"sap/ui/model/odata/v2/ODataModel",
	"sap/ui/model/json/JSONModel",
	"sap/base/Log",
	"modtimesheet/model/DataService"
], function (UIComponent, ODataModel, JSONModel, Log, DataService) {
	"use strict";

	/** The standard HR Fiori service the user's photo is read from. */
	var EMPLOYEE_PICTURE_SERVICE = "/sap/opu/odata/sap/HCMFAB_COMMON_SRV/";

	/**
	 * Part of EmployeePicture's key. It names the calling application for the
	 * HCMFAB customizing/BAdI; MYPROFILE is the one the standard My Profile app
	 * sends. If the backend rejects it, this is the one value to change.
	 */
	var EMPLOYEE_PICTURE_APP_ID = "MYPROFILE";

	return UIComponent.extend("modtimesheet.Component", {

		metadata: {
			manifest: "json"
		},

		init: function () {
			// call the base component's init function
			UIComponent.prototype.init.apply(this, arguments);
			// the backend, when there is one to talk to
			this._setupODataModel();
			// what the header row above the screens shows
			this._setupShellModel();
			// the user circle - name now, photo once it has loaded
			this._loadShellUser();
			// create the views based on the url/hash
			this.getRouter().initialize();
		},

		/**
		 * Fills shell>/user from the ManagerSet entry call. No extra request for
		 * the name: getUserAuthorization is cached, and דף הבית asks it anyway.
		 *
		 * The photo comes from the standard HR Fiori service (HCMFAB_COMMON_SRV,
		 * EmployeePicture, a media entity keyed by ApplicationId + EmployeeId) and
		 * is loaded off-screen first. sap.f.Avatar on 1.71 draws a broken image for
		 * a src that fails, so src is only set once the browser has the picture -
		 * an employee with no photo keeps the person glyph.
		 */
		_loadShellUser: function () {
			var oShell = this.getModel("shell");

			DataService.getUserAuthorization(this).then(function (oUser) {
				oShell.setProperty("/user/name", oUser.displayName);
				oShell.setProperty("/user/visible", true);

				if (DataService.isMockEnvironment() || !oUser.pernr) {
					return;
				}

				var sPernr = ("00000000" + oUser.pernr).slice(-8);
				var sUrl = EMPLOYEE_PICTURE_SERVICE + "EmployeePictureSet(ApplicationId='"
					+ EMPLOYEE_PICTURE_APP_ID + "',EmployeeId='" + sPernr + "')/$value";

				var oImage = new Image();
				oImage.onload = function () {
					oShell.setProperty("/user/src", sUrl);
				};
				oImage.onerror = function () {
					Log.info("Component: no picture for employee " + sPernr + " at " + sUrl);
				};
				oImage.src = sUrl;
			}).catch(function () {
				// the screens report a failed entry call themselves; the circle
				// just stays hidden
			});
		},

		/**
		 * The "shell" model - the state of the header row
		 * (view/AppHeader.fragment.xml).
		 *
		 * On the component and not on a view because the header outlives every
		 * screen: it is drawn once in App.view.xml and the screens come and go
		 * underneath it.
		 *
		 * Both entries start switched off. The user is switched on by
		 * _loadShellUser once ManagerSet answers; there is still no notifications
		 * service to count anything. Filling either in is a setProperty from
		 * wherever that data does arrive, and the bar picks it up with no change to
		 * the fragment:
		 *
		 *   this.getModel("shell").setProperty("/notificationCount", 2);
		 *   this.getModel("shell").setProperty("/user", {
		 *       visible: true, name: "ישראל ישראלי", src: "…/photo.jpg"
		 *   });
		 *
		 * "initials" is the no-photo fallback, and sap.f.Avatar accepts one or two
		 * LATIN letters there - Hebrew ones are rejected and it draws its person
		 * glyph instead, which is the better fallback here anyway.
		 */
		_setupShellModel: function () {
			this.setModel(new JSONModel({
				notificationCount: 0,
				user: {
					visible: false,
					name: "",
					initials: "",
					src: ""
				}
			}), "shell");
		},

		/**
		 * Builds the ZHR_TM_ATTENDANCE_SYSTEM_SRV_N model from the dataSource in
		 * manifest.json - unless this is a mock environment, in which case it is not
		 * built at all and the screens fall back to DataService's mock rows.
		 *
		 * Why here and not declaratively under sap.ui5/models: a model declared in
		 * the manifest is created with the component, and it fires its metadata
		 * request there and then. On this development machine that request can only
		 * fail - there is no NetWeaver behind localhost:8080 - and a screen that
		 * waits for the answer sits on its busy indicator until it arrives, or
		 * forever if nothing ever answers. Not creating the model is the only way to
		 * be sure no request is made and nothing has to be waited for.
		 *
		 * Deployed, DataService.isMockEnvironment() is false and this is simply the
		 * model the manifest would have created, under the same name, so nothing
		 * downstream can tell the difference.
		 */
		_setupODataModel: function () {
			var sName = DataService.ODATA_MODEL_NAME;

			if (DataService.isMockEnvironment()) {
				Log.info("Component: mock environment - " + sName + " was not created,"
					+ " the screens use mock data (?mock=false to force the service)");
				return;
			}

			var oDataSource = (this.getManifestEntry("sap.app").dataSources || {})[sName];
			if (!oDataSource || !oDataSource.uri) {
				Log.error("Component: no dataSource '" + sName + "' in manifest.json");
				return;
			}

			this.setModel(new ODataModel({
				serviceUrl: oDataSource.uri,
				defaultBindingMode: "TwoWay",
				defaultCountMode: "None",
				useBatch: false
			}), sName);
		}
	});
});
