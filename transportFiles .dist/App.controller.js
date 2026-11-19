sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/m/MessageToast",
	"com/mln/ui5/emp_timesheet/model/DataService"
], function (Controller, MessageToast, DataService) {
	"use strict";

	/* ============================================================================
	   App - the shell around the screens
	   ----------------------------------------------------------------------------
	   Nothing but the handlers for views/AppHeader.fragment.xml, which the root view
	   includes above the sap.m.App. The screens themselves are unaffected: each one
	   still owns its Page, its title and its own controller.
	   ========================================================================= */

	return Controller.extend("com.mln.ui5.emp_timesheet.controllers.App", {

		/**
		 * "דף הבית" in the header goes home from anywhere.
		 *
		 * navTo and not a history step back: the link is a fixed destination, not a
		 * way back to wherever the user came from, and on דף הבית itself it is then
		 * a no-op rather than a jump out of the app.
		 *
		 * A tab opened for one employee (?empNum=…&caller=…, see
		 * DataService.buildEmployeeScreenUrl) goes home WITHOUT them. They sit in
		 * the search, which the router cannot touch, and the host app reads them
		 * once on start - so this is a reload onto the clean address, not a navTo.
		 */
		onNavHome: function () {
			var oRouter = this.getOwnerComponent().getRouter();

			if (DataService.hasEmployeeParams()) {
				window.location.assign(window.location.pathname
					+ DataService.stripEmployeeParams(window.location.search)
					+ "#/" + oRouter.getURL("home"));
				return;
			}
			oRouter.navTo("home");
		},

		/** No notifications screen exists in this app yet. */
		onOpenNotifications: function () {
			var oBundle = this.getOwnerComponent().getModel("i18n_manager").getResourceBundle();

			MessageToast.show(oBundle.getText("shNotificationsPlaceholder"));
		}
	});
});
