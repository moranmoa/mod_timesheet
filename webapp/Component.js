sap.ui.define([
	"sap/ui/core/UIComponent",
	"sap/ui/model/odata/v2/ODataModel",
	"sap/base/Log",
	"modtimesheet/model/DataService"
], function (UIComponent, ODataModel, Log, DataService) {
	"use strict";

	return UIComponent.extend("modtimesheet.Component", {

		metadata: {
			manifest: "json"
		},

		init: function () {
			// call the base component's init function
			UIComponent.prototype.init.apply(this, arguments);
			// the backend, when there is one to talk to
			this._setupODataModel();
			// create the views based on the url/hash
			this.getRouter().initialize();
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
