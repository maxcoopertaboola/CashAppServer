/**
 * controllers/matchController.js
 * Controller for Cash App Transaction match operations.
 *
 * GET  action=getMatchData   — retrieve match data for a transaction
 * POST action=applyMatchData — apply match data to a transaction
 */

define(['../services/matchService', 'N/log'], function(matchService, log) {
    return {

        /**
         * Retrieves the full match data payload for a Cash App Transaction.
         *
         * Expected params:
         *   cashAppTranId {number|string} — internal ID of the Cash App Transaction
         *   (alias: id)
         *
         * @param {Object} params - URL query parameters
         * @param {Object} body   - Parsed request body (unused for GET)
         * @returns {Object}
         */
        processGetMatchData: function(params, body) {
            const cashAppTranId = params.cashAppTranId || params.id

            if (!cashAppTranId) {
                throw new Error('Missing required parameter: cashAppTranId')
            }

            log.debug('matchController.processGetMatchData', `cashAppTranId: ${cashAppTranId}`)
            return matchService.getMatchData(cashAppTranId)
        },

        /**
         * Applies match data to a Cash App Transaction.
         *
         * cashAppTranId can be supplied via URL params or request body.
         *
         * Expected body fields:
         *   cashAppTranId                          {number}   — transaction ID (or pass via params)
         *   matches                                {Array}    — [{ id, invoice_type, apply, billcountry?, tblaWht?, rules? }, ...]
         *   writeoff                               {Object}   — write-off data (optional)
         *   customer                               {number}   — customer ID to set (optional)
         *   custrecord_pri_cashapp_trans_exchrate  {number}   — exchange rate (optional)
         *   custrecord_pri_cashapp_trans_foreignamt {number}  — foreign amount (optional)
         *   custrecord_pri_cashapp_trans_foreigncur {number}  — foreign currency ID (optional)
         *   custrecord_pri_cashapp_trans_bankfee   {number}   — bank fee amount (optional)
         *   custrecord_tb_wht_rate                 {number}   — WHT rate percentage (optional)
         *   custrecord_tb_wht_cert_no              {string}   — WHT certificate number (optional)
         *
         * matches[].invoice_type controls how the transaction is applied:
         *   'CustInvc' — invoice (applied via the 'apply' sublist on the Customer Payment)
         *   'CustCred' — credit memo (applied via the 'credit' sublist; does not consume cash)
         *
         * matches[].tblaWht is a JSON string containing WHT data per invoice, e.g.:
         *   { "whtMarkup": 150.00, "baseApplyAmount": 3000.00 }
         *
         * @param {Object} params - URL query parameters
         * @param {Object} body   - Parsed request body
         * @returns {Object}
         */
        processApplyMatchData: function(params, body) {
            const cashAppTranId = params.cashAppTranId
                || params.id
                || body.cashAppTranId
                || body.id

            if (!cashAppTranId) {
                throw new Error('Missing required parameter: cashAppTranId (must be in URL parameters or request body)')
            }

            log.debug('matchController.processApplyMatchData', `cashAppTranId: ${cashAppTranId}`)
            return matchService.applyMatchData(cashAppTranId, body)
        },

        /**
         * Moves the remaining balance to a real Customer Payment for the
         * transaction's assigned customer.
         *
         * cashAppTranId can be supplied via URL params or request body.
         *
         * Optional body field:
         *   consolidate {boolean} — default true; when false forces a new payment
         *                          even if one already exists for this customer/transaction
         *
         * @param {Object} params
         * @param {Object} body
         * @returns {Object}
         */
        processMoveBalanceToCustomer: function(params, body) {
            const cashAppTranId = params.cashAppTranId
                || params.id
                || body.cashAppTranId
                || body.id

            if (!cashAppTranId) {
                throw new Error('Missing required parameter: cashAppTranId (must be in URL parameters or request body)')
            }

            const consolidate = body.consolidate !== undefined ? body.consolidate : true
            const newMemo = body.custrecord_pri_cashapp_trans_memo

            log.debug('matchController.processMoveBalanceToCustomer', `cashAppTranId: ${cashAppTranId}, consolidate: ${consolidate}, newMemo: ${newMemo}`)
            return matchService.moveBalanceToCustomer(cashAppTranId, consolidate, newMemo)
        },

        /**
         * Moves the remaining balance to a Customer Deposit for the
         * transaction's assigned customer.
         *
         * cashAppTranId can be supplied via URL params or request body.
         *
         * @param {Object} params
         * @param {Object} body
         * @returns {Object}
         */
        processMoveBalanceToCustomerDeposit: function(params, body) {
            const cashAppTranId = params.cashAppTranId
                || params.id
                || body.cashAppTranId
                || body.id

            if (!cashAppTranId) {
                throw new Error('Missing required parameter: cashAppTranId (must be in URL parameters or request body)')
            }

            const newMemo = body.custrecord_pri_cashapp_trans_memo

            log.debug('matchController.processMoveBalanceToCustomerDeposit', `cashAppTranId: ${cashAppTranId}, newMemo: ${newMemo}`)
            return matchService.moveBalanceToCustomerDeposit(cashAppTranId, newMemo)
        },

        /**
         * Voids a Cash App Transaction and all its associated customer payments.
         *
         * cashAppTranId can be supplied via URL params or request body.
         *
         * Guard: the service rejects transactions whose status is
         * Applied (Full) or Eliminated.
         *
         * Expected params / body:
         *   cashAppTranId {number|string} — transaction ID
         *   (alias: id)
         *
         * @param {Object} params - URL query parameters
         * @param {Object} body   - Parsed request body
         * @returns {Object}
         */
        processVoidTransaction: function(params, body) {
            const cashAppTranId = params.cashAppTranId
                || params.id
                || body.cashAppTranId
                || body.id

            if (!cashAppTranId) {
                throw new Error('Missing required parameter: cashAppTranId (must be in URL parameters or request body)')
            }

            log.debug('matchController.processVoidTransaction', `cashAppTranId: ${cashAppTranId}`)
            return matchService.voidCashAppTransaction(cashAppTranId)
        },

        /**
         * Creates a Cash Sale (India prepayment) for the transaction's
         * assigned customer, splitting the balance into base + GST item lines.
         *
         * cashAppTranId can be supplied via URL params or request body.
         *
         * @param {Object} params
         * @param {Object} body
         * @returns {Object}
         */
        processCashSalePrepayment: function(params, body) {
            const cashAppTranId = params.cashAppTranId
                || params.id
                || body.cashAppTranId
                || body.id

            if (!cashAppTranId) {
                throw new Error('Missing required parameter: cashAppTranId (must be in URL parameters or request body)')
            }

            const newMemo = body.custrecord_pri_cashapp_trans_memo

            log.debug('matchController.processCashSalePrepayment', `cashAppTranId: ${cashAppTranId}, newMemo: ${newMemo}`)
            return matchService.cashSalePrepayment(cashAppTranId, newMemo)
        },

        /**
         * Retrieves open invoices for a customer and suggests the best
         * combination matching the given transaction amount.
         *
         * Expected params:
         *   customerId                  {number|string} — customer internal ID
         *   cash_app_transaction_amount {number|string} — target amount to match
         *
         * @param {Object} params - URL query parameters
         * @returns {Object}
         */
        processSuggestInvoices: function(params) {
            const cashAppTransactionId = params.cashAppTransactionId
            const customerId           = params.customerId
            const amount               = parseFloat(params.cash_app_transaction_amount)

            if (!cashAppTransactionId) {
                throw new Error('Missing required parameter: cashAppTransactionId')
            }
            if (!customerId) {
                throw new Error('Missing required parameter: customerId')
            }
            if (isNaN(amount) || amount <= 0) {
                throw new Error('Missing or invalid parameter: cash_app_transaction_amount')
            }

            log.debug('matchController.processSuggestInvoices', `cashAppTransactionId: ${cashAppTransactionId}, customerId: ${customerId}, amount: ${amount}`)
            return matchService.suggestInvoices(cashAppTransactionId, customerId, amount)
        }

    }
})
