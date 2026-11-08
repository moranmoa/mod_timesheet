sap.ui.define([], function () {
	"use strict";

	/* ============================================================================
	   "הכל" - the select-all entry at the top of a filter MultiComboBox
	   ----------------------------------------------------------------------------
	   Shared by נתוני כל העובדים and דיווחי עובדים. UI5 1.71 has no select-all of
	   its own (MultiComboBox.showSelectAll arrived in 1.96), so it is an ordinary
	   option with a sentinel key, prepended to the bound list:

	     withAllItem(aItems, "הכל")   - in the model, when the list is long enough
	     onSelectionChange(oEvent)    - from the control's selectionChange
	     getSelectedKeys / getFilterKeys - instead of the control's getSelectedKeys,
	                                    so the sentinel never reaches a filter

	   The sentinel is checked exactly when every real option is - pressing it
	   checks or clears them all, and touching any real option re-derives it.

	   Every function takes the control and nothing else, so the screens keep their
	   own filter logic; this only owns the one extra option.
	   ========================================================================= */

	/** Key of the "הכל" option. Never a real key - nothing in the data uses "__". */
	var ALL_KEY = "__ALL__";

	/** The option is offered only on lists longer than this. */
	var THRESHOLD = 5;

	/**
	 * Marks a control whose every real option is checked. The stylesheet hides the
	 * tokenizer under it, so the field reads "הכל" from its placeholder instead of
	 * squeezing up to hundreds of tokens into one pill.
	 */
	var ALL_SELECTED_CLASS = "mtAllSelected";

	function realKeys(oControl) {
		return oControl.getItems().map(function (oItem) {
			return oItem.getKey();
		}).filter(function (sKey) {
			return sKey !== ALL_KEY;
		});
	}

	function hasAllItem(oControl) {
		return oControl.getItems().some(function (oItem) {
			return oItem.getKey() === ALL_KEY;
		});
	}

	var MultiSelectAll = {

		ALL_KEY: ALL_KEY,

		/**
		 * The option list as it goes into the model: "הכל" first when there are
		 * more than THRESHOLD options, the list unchanged otherwise.
		 *
		 * @param {object[]} aItems {key, text} options
		 * @param {string}   sText  the option's label
		 * @returns {object[]} a new array
		 */
		withAllItem: function (aItems, sText) {
			var a = (aItems || []).filter(function (oItem) {
				return oItem.key !== ALL_KEY;
			});
			return a.length > THRESHOLD ? [{ key: ALL_KEY, text: sText }].concat(a) : a;
		},

		/**
		 * The selected keys without the sentinel - what getSelectedKeys would say if
		 * "הכל" were not an option.
		 *
		 * @param {sap.m.MultiComboBox} oControl the filter
		 * @returns {string[]} the real keys
		 */
		getSelectedKeys: function (oControl) {
			return oControl.getSelectedKeys().filter(function (sKey) {
				return sKey !== ALL_KEY;
			});
		},

		/**
		 * Whether every real option is checked. False on an empty list.
		 *
		 * @param {sap.m.MultiComboBox} oControl the filter
		 * @returns {boolean} the answer
		 */
		isAllSelected: function (oControl) {
			var iOptions = realKeys(oControl).length;
			return iOptions > 0 && this.getSelectedKeys(oControl).length === iOptions;
		},

		/**
		 * The keys a filter should match on: none at all - "no restriction" - when
		 * everything is checked. A row whose value has no option of its own (no
		 * יחידה, say) would otherwise be dropped by a filter that lists every
		 * option there is.
		 *
		 * @param {sap.m.MultiComboBox} oControl the filter
		 * @returns {string[]} the keys to match, [] for no restriction
		 */
		getFilterKeys: function (oControl) {
			return this.isAllSelected(oControl) ? [] : this.getSelectedKeys(oControl);
		},

		/**
		 * Checks every option, "הכל" included.
		 *
		 * @param {sap.m.MultiComboBox} oControl the filter
		 */
		selectAll: function (oControl) {
			oControl.setSelectedKeys(oControl.getItems().map(function (oItem) {
				return oItem.getKey();
			}));
			this.sync(oControl);
		},

		/**
		 * The control's selectionChange. Pressing "הכל" checks or clears everything;
		 * pressing anything else only re-derives "הכל".
		 *
		 * @param {sap.ui.base.Event} oEvent selectionChange of a MultiComboBox
		 */
		onSelectionChange: function (oEvent) {
			var oControl = oEvent.getSource();
			var oItem = oEvent.getParameter("changedItem");

			if (oItem && oItem.getKey() === ALL_KEY) {
				if (oEvent.getParameter("selected")) {
					this.selectAll(oControl);
				} else {
					oControl.setSelectedKeys([]);
					this.sync(oControl);
				}
				return;
			}
			this.sync(oControl);
		},

		/**
		 * Puts "הכל" and the all-selected style in step with the real options. Call
		 * after any programmatic change to the selection - setSelectedKeys does not
		 * fire selectionChange.
		 *
		 * @param {sap.m.MultiComboBox} oControl the filter
		 */
		sync: function (oControl) {
			var bAll = this.isAllSelected(oControl);

			if (hasAllItem(oControl)) {
				var bChecked = oControl.getSelectedKeys().indexOf(ALL_KEY) !== -1;
				if (bAll && !bChecked) {
					oControl.addSelectedKeys([ALL_KEY]);
				} else if (!bAll && bChecked) {
					oControl.removeSelectedKeys([ALL_KEY]);
				}
			}

			oControl.toggleStyleClass(ALL_SELECTED_CLASS, bAll);
		}
	};

	return MultiSelectAll;
});
