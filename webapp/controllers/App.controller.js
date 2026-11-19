sap.ui.define([
	"sap/ui/core/mvc/Controller",
	"sap/m/MessageToast"
], function (Controller, MessageToast) {
	"use strict";

	/* ============================================================================
	   App - the shell around the screens
	   ----------------------------------------------------------------------------
	   Nothing but the handlers for view/AppHeader.fragment.xml, which the root view
	   includes above the sap.m.App. The screens themselves are unaffected: each one
	   still owns its Page, its title and its own controller.
	   ========================================================================= */

	return Controller.extend("modtimesheet.controller.App", {

		/**
		 * "דף הבית" in the header goes home from anywhere.
		 *
		 * navTo and not a history step back: the link is a fixed destination, not a
		 * way back to wherever the user came from, and on דף הבית itself it is then
		 * a no-op rather than a jump out of the app.
		 */
		onNavHome: function () {
			this.getOwnerComponent().getRouter().navTo("home");
		},

		/** No notifications screen exists in this app yet. */
		onOpenNotifications: function () {
			var oBundle = this.getOwnerComponent().getModel("i18n").getResourceBundle();

			MessageToast.show(oBundle.getText("shNotificationsPlaceholder"));
		}
	});
});
