/**
 * services/matchService.js
 * Business logic for retrieving and applying Cash App Transaction match data.
 */

define([
    'N/log',
    'N/record',
    'N/search',
    'N/query',
    'N/format',
    '/.bundle/521028/PRI_CashApp_Common',
    '../config/searchMappingQuery',
    '../utils/matching',
    '/.bundle/521028/PRI_CashApp_SL_ApplyTransaction',
], function(log, record, search, query, format, cashApp, searchMappingQuery, matching, applyTxnSL) {
    const MODULE = 'matchService'
    const MEMO_MAX_LEN = 299
    function truncMemo(v) { return v && v.length > MEMO_MAX_LEN ? v.substring(0, MEMO_MAX_LEN) : v }

    // ─── Private helpers ────────────────────────────────────────────────────────

    /**
     * Updates match data object with current invoice and payment data.
     * @param {Object} matches
     * @param {Array}  invoices
     * @param {Array}  payments
     * @returns {Object}
     */
    function updateMatchDataObject(matches, invoices, payments) {
        const fn = `${MODULE}.updateMatchDataObject`
        log.debug(fn, `${Object.keys(matches).length} matches to process.`)

        for (const k in matches) {
            const match   = matches[k]
            const invoice = !!invoices && invoices.filter(i => i.id == parseInt(match.id))[0]
            const payment = !!payments && payments.filter(p => p.apply_id == parseInt(match.id))[0]

            if (!!invoice) {
                if (!!invoice.recordtype) match.type = invoice.recordtype
                match.entity       = invoice.entity
                match.entityname   = invoice.entityname
                match.tranid       = invoice.tranid
                match.trandate     = invoice.trandate
                match.billcountry  = invoice.billcountry || null
                match.subtotal     = invoice.subtotal ?? invoice.totalnetoftax ?? null
                match.total        = invoice.total
                match.unpaid       = invoice.unpaid
                match.statuslabel  = invoice.statuslabel
                match.status       = invoice.status
                match.subsidiary   = invoice.subsidiary
                match.currency     = invoice.currency
                match.currencyname = invoice.currencyname
            }

            if (!!payment) {
                match.apply       = payment.apply_amount
                match.payment     = payment.id
                match.paymentName = payment.name
            }
        }

        return matches
    }

    /**
     * Parses tblaWht from its stored string form into an object.
     * Returns null when no data is present.
     * @param {string|Object|null} raw
     * @returns {Object|null}
     */
    function parseTblaWht(raw) {
        if (!raw) return null
        if (typeof raw === 'object') return raw
        try { return JSON.parse(raw) } catch (_) { return null }
    }

    /**
     * Ensures tblaWht is stored as a JSON string (the format the downstream
     * plugin expects when it calls JSON.parse(m.tblaWht)).
     * Accepts either an object or an already-stringified value from the caller.
     * @param {string|Object|null} raw
     * @returns {string|null}
     */
    function stringifyTblaWht(raw) {
        if (!raw) return null
        if (typeof raw === 'string') return raw
        try { return JSON.stringify(raw) } catch (_) { return null }
    }

    /**
     * Formats a sorted matches array for sublist display.
     * @param {Array} sortedMatches
     * @returns {Array}
     */
    function formatMatchesForSublist(sortedMatches) {
        const fn = `${MODULE}.formatMatchesForSublist`
        const formatted = []

        for (const match of sortedMatches) {
            if (match.id == null || match.id == undefined) continue

            formatted.push({
                id:            match.id,
                tranid:        match.tranid       || null,
                entity:        match.entity       || null,
                entityname:    match.entityname   || null,
                customer:      match.entity       || null,
                customerName:  match.entityname   || null,
                date:          match.trandate     || null,
                status:        match.status       || null,
                statusLabel:   match.statuslabel  || null,
                statusDisplay: match.statuslabel
                    ? (match.statuslabel.indexOf(':') > -1 ? match.statuslabel.split(':')[1].trim() : match.statuslabel)
                    : null,
                billcountry:  match.billcountry  || null,
                subtotal:     match.subtotal     || null,
                total:        match.total        || 0,
                unpaid:       match.unpaid       || 0,
                balance:      match.unpaid       || 0,
                apply:        match.apply        || null,
                currency:     match.currency     || null,
                currencyName: match.currencyname || null,
                payment:      match.payment      || null,
                paymentName:  match.paymentName  || null,
                rules:        match.rules        || [],
                rulesDisplay: match.rules && match.rules.length ? match.rules.join('\n').slice(0, 300) : null,
                priority:     match.priority     || 999,
                locked:       match.status !== 'A',
                type:         match.type         || 'invoice',
                invoice_type: match.invoice_type  || null,
                tblaWht:      parseTblaWht(match.tblaWht)
            })
        }

        log.debug(fn, `Formatted ${formatted.length} matches`)
        return formatted
    }

    /**
     * Returns the amount unapplied, deriving it from the dummy payment when present.
     * @param {number} dummyPymtId
     * @param {number} paymentAmount
     * @returns {number}
     */
    function getAmountUnapplied(dummyPymtId, paymentAmount) {
        const fn = `${MODULE}.getAmountUnapplied`

        dummyPymtId = !!dummyPymtId && !isNaN(parseInt(dummyPymtId)) && parseInt(dummyPymtId) || -1

        if (dummyPymtId < 0) return paymentAmount

        try {
            const lookup = search.lookupFields({
                type: 'customerpayment',
                id: dummyPymtId,
                columns: ['fxamount', 'total']
            })
            return !!lookup.fxamount && !isNaN(parseFloat(lookup.fxamount))
                ? parseFloat(lookup.fxamount)
                : paymentAmount
        } catch (err) {
            log.error(fn, `Failed to lookup dummy payment: ${err.message}`)
            return paymentAmount
        }
    }

    /**
     * Returns the configured write-off amount from the batch setup.
     * @param {number} batchId
     * @returns {number}
     */
    function getWriteOffAmount(batchId) {
        const fn = `${MODULE}.getWriteOffAmount: ${batchId}`

        if (!!batchId) {
            try {
                const lookup = search.lookupFields({
                    type: 'customrecord_pri_cashapp_batch',
                    id: batchId,
                    columns: ['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_writeoffamt']
                })
                return !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_writeoffamt']
                    && parseFloat(lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_writeoffamt'])
                    || 0
            } catch (err) {
                log.error(fn, `Failed to get write-off amount: ${err.message}`)
            }
        }

        return 0
    }

    /**
     * Calculates the total of all real (non-dummy) customer payments linked to
     * a Cash App Transaction by querying queryPaymentsAndWriteOffs and summing
     * foreignTotal values, optionally converting via exchange rate.
     *
     * @param {number|string} cashAppTranId
     * @param {number|string|null} excludePaymentId - payment ID to exclude (e.g. a phantom dummy)
     * @returns {{ paymentCashTotal: number, hasForeignCurrency: boolean, exchangeRate: number, txnAmount: number }}
     */
    function calculateRealPaymentTotal(cashAppTranId, excludePaymentId) {
        const fn = `${MODULE}.calculateRealPaymentTotal`

        const lookup = search.lookupFields({
            type: 'customrecord_pri_cashapp_transaction',
            id: cashAppTranId,
            columns: [
                'custrecord_pri_cashapp_trans_amount',
                'custrecord_pri_cashapp_trans_exchrate',
                'custrecord_pri_cashapp_trans_foreigncur'
            ]
        })

        const txnAmount = parseFloat(lookup.custrecord_pri_cashapp_trans_amount) || 0
        const exchangeRate = parseFloat(lookup.custrecord_pri_cashapp_trans_exchrate) || 1
        const hasForeignCurrency = lookup.custrecord_pri_cashapp_trans_foreigncur
            && lookup.custrecord_pri_cashapp_trans_foreigncur.length > 0
            && !!lookup.custrecord_pri_cashapp_trans_foreigncur[0]?.value

        const payments = cashApp.queryPaymentsAndWriteOffs(cashAppTranId)
        let paymentCashTotal = 0
        const countedPaymentIds = new Set()

        for (const p of payments) {
            if (excludePaymentId && String(p.id) === String(excludePaymentId)) continue
            if (p.recordtype !== 'customerpayment') continue
            if (countedPaymentIds.has(String(p.id))) continue
            countedPaymentIds.add(String(p.id))

            if (p.amount != null && !isNaN(parseFloat(p.amount))) {
                let amt = Math.abs(parseFloat(p.amount))
                if (hasForeignCurrency && exchangeRate !== 1) {
                    amt = Math.round(amt * exchangeRate * 100) / 100
                }
                paymentCashTotal += amt
            }
        }
        paymentCashTotal = parseFloat(paymentCashTotal.toFixed(2))

        return { paymentCashTotal, hasForeignCurrency, exchangeRate, txnAmount }
    }

    /**
     * After applyCashAppTransaction runs, the bundle's syncPaymentChange UE may
     * re-create a dummy payment with a wrong amount due to a multi-currency
     * exchange-rate bug (it multiplies p.total * p.exchangerate, mixing currencies).
     *
     * This function detects whether the transaction is fully applied and, if a
     * phantom dummy exists, removes it by first unlinking it from the CashApp
     * Transaction so the Customer Payment UE early-returns, then deleting it.
     *
     * @param {number|string} cashAppTranId
     */
    function cleanUpPhantomDummy(cashAppTranId) {
        const fn = `${MODULE}.cleanUpPhantomDummy`

        try {
            const postLookup = search.lookupFields({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId,
                columns: [
                    'custrecord_pri_cashapp_trans_dummypymt',
                    'custrecord_pri_cashapp_trans_amount',
                    'custrecord_pri_cashapp_trans_exchrate',
                    'custrecord_pri_cashapp_trans_foreigncur'
                ]
            })

            const phantomDummyId = postLookup.custrecord_pri_cashapp_trans_dummypymt
                && postLookup.custrecord_pri_cashapp_trans_dummypymt[0]
                && postLookup.custrecord_pri_cashapp_trans_dummypymt[0].value
                || null

            if (!phantomDummyId) {
                log.debug(fn, 'No dummy payment found after apply - nothing to clean up')
                return
            }

            const { paymentCashTotal, txnAmount } = calculateRealPaymentTotal(cashAppTranId, phantomDummyId)

            log.debug(fn, JSON.stringify({
                label: 'Post-apply payment analysis',
                phantomDummyId, txnAmount, paymentCashTotal,
                fullyApplied: Math.abs(txnAmount - paymentCashTotal) < 0.01
            }))

            if (Math.abs(txnAmount - paymentCashTotal) >= 0.01) {
                log.debug(fn, `Transaction not fully applied (diff=${(txnAmount - paymentCashTotal).toFixed(2)}) - keeping dummy payment`)
                return
            }

            log.audit(fn, `Transaction fully applied (paymentCashTotal=${paymentCashTotal}). Cleaning up phantom dummy ${phantomDummyId}`)

            // 1. Unlink dummy from the Cash App Transaction and set correct status
            record.submitFields({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId,
                values: {
                    custrecord_pri_cashapp_trans_dummypymt: '',
                    custrecord_pri_cashapp_trans_matchstatus: cashApp.MATCH_STATUS.APPLIED_FULL,
                    custrecord_pri_cashapp_trans_matchissues: ''
                }
            })

            // 2. Clear the CashApp link on the phantom dummy so the Customer Payment
            //    UE's syncPaymentChange will early-return and not re-create it
            record.submitFields({
                type: 'customerpayment',
                id: phantomDummyId,
                values: { custbody_pri_cashapp_transaction: '' }
            })

            // 3. Delete the orphaned phantom dummy
            record.delete({ type: 'customerpayment', id: parseInt(phantomDummyId) })
            log.audit(fn, `Phantom dummy payment ${phantomDummyId} deleted`)

        } catch (err) {
            log.error(fn, `Post-apply cleanup failed: ${err.message}. ${err.stack || ''}`)
            return `Phantom dummy cleanup failed: ${err.message}`
        }
        return null
    }

    /**
     * After moveBalanceToCustomer / moveBalanceToCustomerDeposit runs, the bundle's
     * syncPaymentChange UE fires (triggered by the dummy-payment DELETE) and may
     * re-create a phantom dummy payment via the same exchange-rate bug as applyMatchData:
     * it multiplies p.total × p.exchangerate, mixing home and transaction currencies,
     * leaving a spurious balance of paymentAmount × (1 − exchangeRate).
     *
     * Unlike cleanUpPhantomDummy (used after applyMatchData), we do NOT need to
     * verify the "fully applied" amount because moveBalance operations explicitly
     * move ALL remaining balance — any dummy still present afterward is definitionally
     * phantom.  The match status must stay MANUAL (already written by the bundle);
     * we only need to clear the stale dummypymt reference and delete the phantom.
     *
     * @param {number|string} cashAppTranId
     */
    function cleanUpPhantomDummyAfterMove(cashAppTranId) {
        const fn = `${MODULE}.cleanUpPhantomDummyAfterMove`

        try {
            const lookup = search.lookupFields({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId,
                columns: ['custrecord_pri_cashapp_trans_dummypymt']
            })

            const phantomDummyId = lookup.custrecord_pri_cashapp_trans_dummypymt
                && lookup.custrecord_pri_cashapp_trans_dummypymt[0]
                && lookup.custrecord_pri_cashapp_trans_dummypymt[0].value
                || null

            if (!phantomDummyId) {
                log.debug(fn, `No phantom dummy found on Cash App Transaction ${cashAppTranId} after moveBalance - nothing to clean up`)
                return
            }

            log.audit(fn, `Phantom dummy ${phantomDummyId} detected after moveBalance on ${cashAppTranId}. Cleaning up.`)

            // 1. Clear dummypymt reference on the CashApp Transaction (status stays MANUAL,
            //    already set by the bundle's record.submitFields inside moveBalanceToCustomer)
            record.submitFields({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId,
                values: { custrecord_pri_cashapp_trans_dummypymt: '' }
            })

            // 2. Clear the CashApp link on the phantom dummy so the Customer Payment
            //    UE's syncPaymentChange will early-return instead of re-creating it
            record.submitFields({
                type: 'customerpayment',
                id: phantomDummyId,
                values: { custbody_pri_cashapp_transaction: '' }
            })

            // 3. Delete the orphaned phantom dummy
            record.delete({ type: 'customerpayment', id: parseInt(phantomDummyId) })
            log.audit(fn, `Phantom dummy payment ${phantomDummyId} deleted after moveBalance on ${cashAppTranId}`)

        } catch (err) {
            log.error(fn, `Post-moveBalance phantom cleanup failed: ${err.message}. ${err.stack || ''}`)
            return `Phantom dummy cleanup failed: ${err.message}`
        }
        return null
    }

    /**
     * Safety net for partial applications: after applyCashAppTransaction and
     * cleanUpPhantomDummy run, the dummy payment for the remaining unapplied
     * amount may have been lost due to the syncPaymentChange UE cascade
     * (offsetDummyPayment is called twice — once by applyCashAppTransaction and
     * again by syncPaymentChange — reducing the dummy to zero and deleting it).
     *
     * This function detects that situation and creates a new dummy customer
     * payment for the remaining unapplied amount, mirroring the logic the bundle
     * uses inside createPayment for isDummyPayment=true.
     *
     * @param {number|string} cashAppTranId
     * @returns {string|null} warning message if something went wrong, null on success
     */
    function ensureDummyPaymentForRemainder(cashAppTranId) {
        const fn = `${MODULE}.ensureDummyPaymentForRemainder`

        try {
            const postLookup = search.lookupFields({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId,
                columns: [
                    'custrecord_pri_cashapp_trans_dummypymt',
                    'custrecord_pri_cashapp_trans_amount',
                    'custrecord_pri_cashapp_trans_batch',
                    'custrecord_pri_cashapp_trans_date',
                    'custrecord_pri_cashapp_trans_memo',
                    'custrecord_pri_cashapp_trans_paymethod',
                    'custrecord_pri_cashapp_trans_check_no',
                    'custrecord_pri_cashapp_trans_matchstatus'
                ]
            })

            const existingDummy = postLookup.custrecord_pri_cashapp_trans_dummypymt
                && postLookup.custrecord_pri_cashapp_trans_dummypymt[0]
                && postLookup.custrecord_pri_cashapp_trans_dummypymt[0].value
                || null

            if (existingDummy) {
                log.debug(fn, `Dummy payment ${existingDummy} already exists — nothing to do`)
                return null
            }

            const txnAmount = parseFloat(postLookup.custrecord_pri_cashapp_trans_amount) || 0
            const batchId = postLookup.custrecord_pri_cashapp_trans_batch
                && postLookup.custrecord_pri_cashapp_trans_batch[0]
                && postLookup.custrecord_pri_cashapp_trans_batch[0].value
                || null
            const matchStatusArr = postLookup.custrecord_pri_cashapp_trans_matchstatus
            const matchStatus = matchStatusArr && matchStatusArr[0] && matchStatusArr[0].value || null

            if (matchStatus === cashApp.MATCH_STATUS.APPLIED_FULL
                || matchStatus === cashApp.MATCH_STATUS.ELIMINATED) {
                log.debug(fn, `Transaction is ${matchStatus} — no dummy needed`)
                return null
            }

            const { paymentCashTotal } = calculateRealPaymentTotal(cashAppTranId, null)
            const remaining = parseFloat((txnAmount - paymentCashTotal).toFixed(2))

            log.debug(fn, JSON.stringify({
                label: 'Remainder check',
                txnAmount, paymentCashTotal, remaining, existingDummy
            }))

            if (remaining < 0.01) {
                log.debug(fn, 'No remaining unapplied amount — no dummy needed')
                return null
            }

            const setup = cashApp.lookupCashAppSetupByBatch(batchId)
            if (!setup || !setup.dummyCustomer) {
                log.error(fn, 'Cannot create dummy: no dummyCustomer in batch setup')
                return 'Cannot create dummy payment: missing dummy customer in batch setup'
            }

            const txnDate = postLookup.custrecord_pri_cashapp_trans_date
            const memo = postLookup.custrecord_pri_cashapp_trans_memo || ''
            const paymentMethodArr = postLookup.custrecord_pri_cashapp_trans_paymethod
            const paymentMethod = paymentMethodArr && paymentMethodArr[0] && paymentMethodArr[0].value || null
            const checkNo = postLookup.custrecord_pri_cashapp_trans_check_no || ''

            log.audit(fn, `Creating dummy payment for remaining ${remaining} on Cash App Transaction ${cashAppTranId}`)

            // Use the setup-configured custom payment form when provided; otherwise let
            // NetSuite default. Must be passed via defaultValues so the form is set
            // before any other fields, mirroring createPayment in PRI_CashApp_Common.
            const createOpts = { type: 'customerpayment', isDynamic: true }
            if (setup.defaultPaymentForm)
                createOpts.defaultValues = { customform: setup.defaultPaymentForm }
            const pymt = record.create(createOpts)
            pymt.setValue({ fieldId: 'customer', value: setup.dummyCustomer })

            if (setup.defaultSubsidiary)
                pymt.setValue({ fieldId: 'subsidiary', value: setup.defaultSubsidiary })
            if (setup.defaultCurrency)
                pymt.setValue({ fieldId: 'currency', value: setup.defaultCurrency })

            pymt.setValue({ fieldId: 'custbody_pri_cashapp_batch', value: batchId })
            pymt.setValue({ fieldId: 'custbody_pri_cashapp_transaction', value: cashAppTranId })

            if (txnDate) {
                const dt = format.parse({ value: txnDate, type: format.Type.DATE })
                if (dt)
                    pymt.setValue({ fieldId: 'trandate', value: dt })
            }

            pymt.setValue({ fieldId: 'autoapply', value: false })

            if (memo)
                pymt.setValue({ fieldId: 'memo', value: truncMemo(memo) })
            if (setup.defaultLocation)
                pymt.setValue({ fieldId: 'location', value: setup.defaultLocation })
            if (paymentMethod)
                pymt.setValue({ fieldId: 'paymentmethod', value: paymentMethod, ignoreFieldChange: true })
            if (checkNo)
                pymt.setValue({ fieldId: 'checknum', value: checkNo })

            if (!setup.undepositedFunds && setup.cashAccount) {
                try {
                    pymt.setValue({ fieldId: 'undepfunds', value: 'F' })
                    pymt.setValue({ fieldId: 'account', value: setup.cashAccount })
                } catch (acctErr) {
                    log.error(fn, `Failed to set cash account on dummy: ${acctErr.message}`)
                    pymt.setValue({ fieldId: 'undepfunds', value: 'T' })
                    pymt.setValue({ fieldId: 'account', value: '' })
                }
            } else {
                pymt.setValue({ fieldId: 'undepfunds', value: 'T' })
            }

            pymt.setValue({ fieldId: 'payment', value: remaining })

            const dummyPymtId = pymt.save({ ignoreMandatoryFields: true })
            log.audit(fn, `Dummy payment ${dummyPymtId} created for remaining ${remaining}`)

            record.submitFields({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId,
                values: {
                    custrecord_pri_cashapp_trans_dummypymt: dummyPymtId,
                    custrecord_pri_cashapp_trans_matchstatus: cashApp.MATCH_STATUS.APPLIED_PARTIAL
                }
            })

            return null
        } catch (err) {
            log.error(fn, `Failed to ensure dummy payment: ${err.message}. ${err.stack || ''}`)
            return `Failed to create dummy payment for remainder: ${err.message}`
        }
    }

    /**
     * Reads the CashApp Transaction's post-operation state and returns an array
     * of warning strings describing any issues detected (empty if everything is clean).
     * @param {number|string} cashAppTranId
     * @returns {Array<string>}
     */
    function getPostOperationWarnings(cashAppTranId) {
        const fn = `${MODULE}.getPostOperationWarnings`
        const warnings = []
        try {
            const lookup = search.lookupFields({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId,
                columns: [
                    'custrecord_pri_cashapp_trans_matchstatus',
                    'custrecord_pri_cashapp_trans_matchissues'
                ]
            })
            const statusArr = lookup.custrecord_pri_cashapp_trans_matchstatus
            const statusValue = statusArr && statusArr[0] && statusArr[0].value || null
            const statusText = statusArr && statusArr[0] && statusArr[0].text || null

            if (statusValue && statusValue !== cashApp.MATCH_STATUS.APPLIED_FULL
                && statusValue !== cashApp.MATCH_STATUS.APPLIED_PARTIAL
                && statusValue !== cashApp.MATCH_STATUS.MANUAL
                && statusValue !== cashApp.MATCH_STATUS.ELIMINATED) {
                warnings.push(`Match status is "${statusText || statusValue}" (expected Applied Full or Applied Partial)`)
            }

            const issues = lookup.custrecord_pri_cashapp_trans_matchissues
            if (issues && issues.length > 0) {
                const filteredIssues = issues.filter(function(i) {
                    const issueValue = i && typeof i === 'object' ? i.value : i
                    return issueValue !== cashApp.MATCH_ISSUE.NO_MATCH_FOUND
                })
                if (filteredIssues.length > 0) {
                    const issueTexts = filteredIssues.map(function(i) { return i.text || i.value }).join(', ')
                    warnings.push(`Match issues: ${issueTexts}`)
                }
            }
        } catch (err) {
            log.error(fn, `Post-operation state check failed: ${err.message}`)
        }
        return warnings
    }

    // ─── Public methods ──────────────────────────────────────────────────────────

    /**
     * Retrieves the full match data payload for a Cash App Transaction.
     * @param {number|string} cashAppTranId
     * @returns {Object}
     */
    function getMatchData(cashAppTranId) {
        const fn = `${MODULE}.getMatchData`

        const rec = record.load({
            type: 'customrecord_pri_cashapp_transaction',
            id: cashAppTranId
        })

        const paymentAmount  = parseFloat(rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_amount' }))
        const foreignAmount  = parseFloat(rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_foreignamt' }))
        const foreignCurrency = rec.getText({ fieldId: 'custrecord_pri_cashapp_trans_foreigncur' })
        const dummyPymt      = rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_dummypymt' })
        const bankFee        = rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_bankfee' })
        const batchId        = rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_batch' })
        const currency       = rec.getValue({ fieldId: 'custrecord_pri_cashapp_trns_currencycode' })
        const date           = rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_date' })
        const customerName   = rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_cust_name' })
        const memo           = rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_memo' }) || null
        const whtRate        = parseFloat(rec.getValue({ fieldId: 'custrecord_tb_wht_rate' }))
        const whtCertNo      = rec.getValue({ fieldId: 'custrecord_tb_wht_cert_no' }) || null

        const batchLookup = search.lookupFields({
            type: 'customrecord_pri_cashapp_batch',
            id: batchId,
            columns: [
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_currency',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_subsidiary',
                'custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_regime',
                'custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_account',
                'custrecord_pri_cashapp_batch_setup.custrecord_tb_last_year_wht_account'
            ]
        })
        const defaultCurrency   = batchLookup?.['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_currency']?.[0]?.text
        const defaultSubsidiary = batchLookup?.['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_subsidiary']?.[0]?.value || null
        const taboolaWHTRegime  = batchLookup?.['custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_regime']?.[0]?.value || null
        const taboolaWHTAccount = batchLookup?.['custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_account']?.[0]?.value || null
        // India regime only: optional override account for invoices dated before
        // 01.04 of the current Indian fiscal year. Returned to the UI alongside
        // taboolaWHTAccount so it can be displayed/edited the same way.
        const taboolaLastYearWHTAccount = batchLookup?.['custrecord_pri_cashapp_batch_setup.custrecord_tb_last_year_wht_account']?.[0]?.value || null

        let exchangeRate           = 1
        let foreignAmountCalculated = null
        let fxDifference           = null

        if (foreignCurrency && foreignCurrency !== defaultCurrency) {
            exchangeRate            = cashApp.getCurrencyExchangeRate(date, currency, foreignCurrency, defaultCurrency)
            foreignAmountCalculated = Math.round(paymentAmount / exchangeRate * 100) / 100
            if (foreignAmount) {
                fxDifference = Math.round((foreignAmount - foreignAmountCalculated) * 100) / 100
            }
        }

        let matches = {}
        try {
            matches = JSON.parse(rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_matches' }))
        } catch (err) {
            log.debug(fn, `Failed to parse matches: ${err.message}`)
        }

        const payments       = cashApp.queryPaymentsAndWriteOffs(cashAppTranId)
        const invoices       = cashApp.queryMatchedTransactionData(Object.keys(matches), `matchService_${cashAppTranId}`)
        const amountRemaining = getAmountUnapplied(dummyPymt, paymentAmount)

        matches = updateMatchDataObject(matches, invoices, payments)

        const sortedMatches   = cashApp.sortMatchedTransactions(batchId, matches)
        const formattedMatches = formatMatchesForSublist(sortedMatches)
        const writeOffAmount  = getWriteOffAmount(batchId)

        let mergedMatches = [...formattedMatches]

        if (customerName) {
            try {
                const openInvoices       = cashApp.queryOpenTransactionsByClientName(customerName, defaultSubsidiary)
                const formattedOpen      = formatMatchesForSublist(openInvoices)
                const existingMatchIds   = new Set(formattedMatches.map(m => m.id))
                formattedOpen.forEach(invoice => {
                    if (!existingMatchIds.has(invoice.id)) mergedMatches.push(invoice)
                })
                log.debug(fn, `Merged ${formattedMatches.length} matched + ${mergedMatches.length - formattedMatches.length} open invoices = ${mergedMatches.length} total`)
            } catch (err) {
                log.error(fn, `Failed to query open invoices: ${err.message}`)
            }
        }

        return {
            cashAppTranId:          parseInt(cashAppTranId),
            batchId:                batchId,
            paymentAmount:          paymentAmount,
            amountRemaining:        amountRemaining,
            bankFee:                bankFee,
            memo:                   memo,
            currency:               currency,
            defaultCurrency:        defaultCurrency,
            foreignCurrency:        foreignCurrency,
            foreignAmount:          foreignAmount,
            foreignAmountCalculated: foreignAmountCalculated,
            fxDifference:           fxDifference,
            exchangeRate:           exchangeRate,
            writeOffAmount:         writeOffAmount,
            taboolaWHTRegime:       taboolaWHTRegime,
            taboolaWHTAccount:      taboolaWHTAccount,
            taboolaLastYearWHTAccount: taboolaLastYearWHTAccount,
            whtRate:                !isNaN(whtRate) ? whtRate : null,
            whtCertificateNumber:   whtCertNo,
            matchCount:             mergedMatches.length,
            matches:                mergedMatches
        }
    }

    /**
     * Applies match data (and optional writeoff / customer / FX / bank fee fields) to a Cash App Transaction.
     * @param {number|string} cashAppTranId
     * @param {Object} requestBody
     * @param {Array}  [requestBody.matches]
     * @param {Object} [requestBody.writeoff]
     * @param {number} [requestBody.customer]
     * @param {number} [requestBody.custrecord_pri_cashapp_trans_exchrate]
     * @param {number} [requestBody.custrecord_pri_cashapp_trans_foreignamt]
     * @param {number} [requestBody.custrecord_pri_cashapp_trans_foreigncur]
     * @param {number} [requestBody.custrecord_pri_cashapp_trans_bankfee] - Bank fee amount; triggers a bankfeeunderpayment write-off inside applyCashAppTransaction
     * @param {string} [requestBody.custrecord_pri_cashapp_trans_memo] - Free-text memo on the Cash App Transaction
     * @param {number} [requestBody.custrecord_tb_wht_rate] - WHT rate percentage
     * @param {string} [requestBody.custrecord_tb_wht_cert_no] - WHT certificate number
     * @returns {Object}
     */
    function applyMatchData(cashAppTranId, requestBody) {
        const fn = `${MODULE}.applyMatchData`

        log.debug(fn, `Starting apply for Cash App Transaction ${cashAppTranId}`)
        log.debug(fn, `Request body: ${JSON.stringify(requestBody)}`)

        let rec
        try {
            rec = record.load({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId
            })
        } catch (err) {
            throw new Error(`Failed to load Cash App Transaction ${cashAppTranId}: ${err.message}`)
        }

        const oldCustomer = rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_customer' })

        let matches = {}
        try {
            const matchesStr = rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_matches' })
            if (matchesStr) matches = JSON.parse(matchesStr)
            if (!matches || typeof matches !== 'object') matches = {}
            log.debug(fn, `Loaded ${Object.keys(matches).length} existing matches`)
        } catch (err) {
            log.debug(fn, `Failed to parse existing matches: ${err.message}. Starting with empty matches.`)
            matches = {}
        }

        if (requestBody.matches && Array.isArray(requestBody.matches)) {
            log.debug(fn, `Processing ${requestBody.matches.length} matches from request`)
            const requestedMatchIds = []

            for (const match of requestBody.matches) {
                if (!match.id) {
                    log.debug(fn, `Skipping match without id: ${JSON.stringify(match)}`)
                    continue
                }

                const matchId = match.id.toString()
                requestedMatchIds.push(matchId)

                if (!matches.hasOwnProperty(matchId)) {
                    matches[matchId] = {
                        id:          parseInt(matchId),
                        type:        match.type  || 'invoice',
                        invoice_type: match.invoice_type || null,
                        apply:       match.apply != null && !isNaN(parseFloat(match.apply)) ? parseFloat(match.apply) : null,
                        billcountry: match.billcountry || null,
                        tblaWht:     stringifyTblaWht(match.tblaWht),
                        rules:       match.rules || ['API']
                    }
                } else {
                    if (match.apply === '' || match.apply === null) {
                        matches[matchId].apply = null
                    } else if (!isNaN(parseFloat(match.apply))) {
                        matches[matchId].apply = parseFloat(match.apply)
                    }
                    if (match.invoice_type) {
                        matches[matchId].invoice_type = match.invoice_type
                    }
                    if (match.billcountry && !matches[matchId].billcountry) {
                        matches[matchId].billcountry = match.billcountry
                    }
                    if (match.tblaWht) {
                        matches[matchId].tblaWht = stringifyTblaWht(match.tblaWht)
                    }
                }
            }

            for (const k in matches) {
                if (!requestedMatchIds.includes(k) && !matches[k].priority) {
                    delete matches[k]
                }
            }

            log.debug(fn, `After processing request: ${Object.keys(matches).length} total matches`)
        }

        const payments = cashApp.queryPaymentsAndWriteOffs(cashAppTranId)
        const invoices = cashApp.queryMatchedTransactionData(Object.keys(matches), `matchService_${cashAppTranId}`)
        matches = updateMatchDataObject(matches, invoices, payments)

        for (const matchId in matches) {
            if (matches[matchId].tblaWht === undefined) {
                matches[matchId].tblaWht = null
            }
        }

        rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_matches', value: JSON.stringify(matches) })

        if (requestBody.customer) {
            rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_customer', value: requestBody.customer })
        }

        // FX fields: "" means "clear" (no FX conversion), undefined means "don't touch".
        // Clearing foreigncur is critical: applyCashAppTransaction multiplies applyTotal
        // by exchangeRate when foreignCurrency is set, which causes the dummy payment
        // offset to use the base-currency amount instead of the payment-currency amount.
        const foreignCur = requestBody.custrecord_pri_cashapp_trans_foreigncur
        const clearFx = foreignCur !== undefined && (foreignCur === '' || foreignCur === null)

        log.debug(fn, JSON.stringify({
            label: 'FX input values',
            foreignCur_raw: foreignCur,
            foreignCur_type: typeof foreignCur,
            exchRate_raw: requestBody.custrecord_pri_cashapp_trans_exchrate,
            foreignAmt_raw: requestBody.custrecord_pri_cashapp_trans_foreignamt,
            bankFee_raw: requestBody.custrecord_pri_cashapp_trans_bankfee,
            clearFx
        }))

        if (clearFx) {
            log.debug(fn, 'Clearing all FX fields on the record')
            rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_foreigncur', value: '' })
            rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_exchrate', value: '' })
            rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_foreignamt', value: '' })
        } else if (foreignCur !== undefined) {
            rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_foreigncur', value: foreignCur })

            const exchRate = requestBody.custrecord_pri_cashapp_trans_exchrate
            if (exchRate != null && exchRate !== '' && !isNaN(parseFloat(exchRate))) {
                rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_exchrate', value: parseFloat(exchRate) })
            }

            const foreignAmt = requestBody.custrecord_pri_cashapp_trans_foreignamt
            if (foreignAmt != null && foreignAmt !== '' && !isNaN(parseFloat(foreignAmt))) {
                rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_foreignamt', value: parseFloat(foreignAmt) })
            }
        }

        const bankFee = requestBody.custrecord_pri_cashapp_trans_bankfee
        if (bankFee !== undefined) {
            if (bankFee === '' || bankFee === null) {
                rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_bankfee', value: '' })
            } else if (!isNaN(parseFloat(bankFee))) {
                rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_bankfee', value: parseFloat(bankFee) })
            }
        }

        const reqMemo = requestBody.custrecord_pri_cashapp_trans_memo
        if (reqMemo !== undefined) {
            if (reqMemo === '' || reqMemo === null) {
                rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_memo', value: '' })
            } else {
                rec.setValue({ fieldId: 'custrecord_pri_cashapp_trans_memo', value: reqMemo })
            }
        }

        const reqWhtRate = requestBody.custrecord_tb_wht_rate
        if (reqWhtRate !== undefined) {
            if (reqWhtRate === '' || reqWhtRate === null) {
                rec.setValue({ fieldId: 'custrecord_tb_wht_rate', value: '' })
            } else if (!isNaN(parseFloat(reqWhtRate))) {
                rec.setValue({ fieldId: 'custrecord_tb_wht_rate', value: parseFloat(reqWhtRate) })
            }
        }

        const reqWhtCertNo = requestBody.custrecord_tb_wht_cert_no
        if (reqWhtCertNo !== undefined) {
            if (reqWhtCertNo === '' || reqWhtCertNo === null) {
                rec.setValue({ fieldId: 'custrecord_tb_wht_cert_no', value: '' })
            } else {
                rec.setValue({ fieldId: 'custrecord_tb_wht_cert_no', value: reqWhtCertNo })
            }
        }

        log.debug(fn, JSON.stringify({
            label: 'Record values BEFORE save',
            foreigncur: rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_foreigncur' }),
            exchrate: rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_exchrate' }),
            foreignamt: rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_foreignamt' }),
            bankfee: rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_bankfee' }),
            memo: rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_memo' }),
            dummypymt: rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_dummypymt' }),
            whtRate: rec.getValue({ fieldId: 'custrecord_tb_wht_rate' }),
            whtCertNo: rec.getValue({ fieldId: 'custrecord_tb_wht_cert_no' })
        }))

        const savedId = rec.save()
        log.audit(fn, `Saved Cash App Transaction: ${savedId} with ${Object.keys(matches).length} matches`)

        const postSaveLookup = search.lookupFields({
            type: 'customrecord_pri_cashapp_transaction',
            id: cashAppTranId,
            columns: [
                'custrecord_pri_cashapp_trans_foreigncur',
                'custrecord_pri_cashapp_trans_exchrate',
                'custrecord_pri_cashapp_trans_foreignamt',
                'custrecord_pri_cashapp_trans_bankfee',
                'custrecord_pri_cashapp_trans_dummypymt'
            ]
        })
        log.debug(fn, JSON.stringify({
            label: 'DB values AFTER save (what applyCashAppTransaction will read)',
            foreigncur: postSaveLookup.custrecord_pri_cashapp_trans_foreigncur,
            exchrate: postSaveLookup.custrecord_pri_cashapp_trans_exchrate,
            foreignamt: postSaveLookup.custrecord_pri_cashapp_trans_foreignamt,
            bankfee: postSaveLookup.custrecord_pri_cashapp_trans_bankfee,
            dummypymt: postSaveLookup.custrecord_pri_cashapp_trans_dummypymt
        }))

        // If foreigncur is STILL set after save despite our clear attempt, force-clear via submitFields
        if (clearFx) {
            const stillHasFx = postSaveLookup.custrecord_pri_cashapp_trans_foreigncur
                && postSaveLookup.custrecord_pri_cashapp_trans_foreigncur.length > 0
                && !!postSaveLookup.custrecord_pri_cashapp_trans_foreigncur[0]?.value
            if (stillHasFx) {
                log.audit(fn, 'FX fields were NOT cleared by rec.save() - forcing clear via submitFields')
                record.submitFields({
                    type: 'customrecord_pri_cashapp_transaction',
                    id: cashAppTranId,
                    values: {
                        custrecord_pri_cashapp_trans_foreigncur: '',
                        custrecord_pri_cashapp_trans_exchrate: '',
                        custrecord_pri_cashapp_trans_foreignamt: ''
                    }
                })
            }
        }

        const woData = requestBody.writeoff || null

        const whtLookup = search.lookupFields({
            type: 'customrecord_pri_cashapp_transaction',
            id: cashAppTranId,
            columns: ['custrecord_tb_wht_rate', 'custrecord_tb_wht_cert_no']
        })
        const savedWhtRate = parseFloat(whtLookup.custrecord_tb_wht_rate)
        const savedWhtCertNo = whtLookup.custrecord_tb_wht_cert_no || null

        const taboolaWHTData = {
            rate: !isNaN(savedWhtRate) ? savedWhtRate : undefined,
            certificateNumber: savedWhtCertNo || undefined
        }

        log.debug(fn, JSON.stringify({ label: 'taboolaWHTData', taboolaWHTData }))
        log.audit(fn, `Applying Cash App Transaction ${cashAppTranId}`)

        const warnings = []

        try {
            cashApp.applyCashAppTransaction(cashAppTranId, woData, taboolaWHTData)
        } catch (applyErr) {
            log.error(fn, `applyCashAppTransaction threw: ${applyErr.message}. ${applyErr.stack || ''}`)
            warnings.push(`Apply failed: ${applyErr.message}`)
        }

        const newCustomer = requestBody.customer || rec.getValue({ fieldId: 'custrecord_pri_cashapp_trans_customer' })
        if (oldCustomer != newCustomer && newCustomer) {
            log.audit(fn, `Customer changed from ${oldCustomer} to ${newCustomer}`)
            try {
                cashApp.changeCashAppTransactionCustomer(cashAppTranId, newCustomer)
            } catch (custErr) {
                log.error(fn, `changeCashAppTransactionCustomer threw: ${custErr.message}. ${custErr.stack || ''}`)
                warnings.push(`Customer change failed: ${custErr.message}`)
            }
        }

        const cleanupErr = cleanUpPhantomDummy(cashAppTranId)
        if (cleanupErr) warnings.push(cleanupErr)

        const dummyErr = ensureDummyPaymentForRemainder(cashAppTranId)
        if (dummyErr) warnings.push(dummyErr)

        const postWarnings = getPostOperationWarnings(cashAppTranId)
        warnings.push.apply(warnings, postWarnings)

        const finalStatusLookup = search.lookupFields({
            type: 'customrecord_pri_cashapp_transaction',
            id: cashAppTranId,
            columns: ['custrecord_pri_cashapp_trans_matchstatus']
        })
        const finalStatusArr = finalStatusLookup.custrecord_pri_cashapp_trans_matchstatus
        const finalStatus = finalStatusArr && finalStatusArr[0] && finalStatusArr[0].value || null
        const finalStatusText = finalStatusArr && finalStatusArr[0] && finalStatusArr[0].text || null

        const isFullyApplied = finalStatus === cashApp.MATCH_STATUS.APPLIED_FULL
        const isPartiallyApplied = finalStatus === cashApp.MATCH_STATUS.APPLIED_PARTIAL
        const applySucceeded = isFullyApplied || isPartiallyApplied

        if (!applySucceeded) {
            log.error(fn, `Cash App Transaction ${cashAppTranId} apply failed. Status: ${finalStatus}. Warnings: ${JSON.stringify(warnings)}`)
        } else if (warnings.length) {
            log.error(fn, `Cash App Transaction ${cashAppTranId} applied${isPartiallyApplied ? ' (partial)' : ''} with warnings: ${JSON.stringify(warnings)}`)
        } else {
            log.audit(fn, `Successfully applied Cash App Transaction ${cashAppTranId}${isPartiallyApplied ? ' (partial)' : ''}`)
        }

        return {
            cashAppTranId:   parseInt(cashAppTranId),
            matchesUpdated:  Object.keys(matches).length,
            applied:         applySucceeded,
            partialApply:    isPartiallyApplied,
            matchStatus:     finalStatus,
            matchStatusText: finalStatusText,
            warnings:        warnings.length > 0 ? warnings : undefined,
            message:         !applySucceeded
                ? 'Cash App Transaction apply failed'
                : isPartiallyApplied
                    ? 'Cash App Transaction partially applied successfully'
                    : 'Cash App Transaction applied successfully'
        }
    }

    /**
     * Queries open invoices for a customer, marks the best combination
     * whose unpaid balances sum to the given transaction amount, and
     * saves the suggested customer on the Cash App Transaction record.
     *
     * @param {number|string} cashAppTransactionId
     * @param {number|string} customerId
     * @param {number}        amount - cash app transaction amount
     * @returns {Object} - { cash_app_transaction_amount, invoices }
     */
    function suggestInvoices(cashAppTransactionId, customerId, amount) {
        const fn = `${MODULE}.suggestInvoices`

        record.submitFields({
            type: 'customrecord_pri_cashapp_transaction',
            id: cashAppTransactionId,
            values: {
                custrecord_pri_cashapp_suggested_cust: customerId,
                custrecord_pri_cashapp_trans_customer: customerId
            }
        })
        log.debug(fn, `Updated suggested customer and customer to ${customerId} on transaction ${cashAppTransactionId}`)

        const whtContext = lookupWhtContextForTransaction(cashAppTransactionId)

        const config = searchMappingQuery.getMappingQuery('open_invoices_by_customer', customerId)
        const invoiceRows = query.runSuiteQL({ query: config.query, params: config.params }).asMappedResults()
        log.debug(fn, `Found ${invoiceRows.length} open invoices for customer ${customerId}`)

        var transaction = {
            cash_app_transaction_amount:    amount,
            cash_app_transaction_wht_regime: whtContext.regime,
            cash_app_transaction_wht_rate:   whtContext.rate,
            invoices: invoiceRows.map(function(row) {
                return {
                    invoice_id:              row.invoice_id,
                    invoice_date:            row.invoice_date,
                    invoice_number:          row.invoice_number,
                    invoice_currency:        row.invoice_currency,
                    invoice_total:           parseFloat(row.invoice_total) || 0,
                    invoice_subtotal:        parseFloat(row.invoice_subtotal) || 0,
                    invoice_unpaid_balance:  parseFloat(row.invoice_unpaid_balance) || 0
                }
            })
        }

        var result = matching.matchInvoicesToTransactions([transaction])
        return result[0]
    }

    /**
     * Returns { regime, rate } needed by matching.matchInvoicesToTransactions
     * to decide whether to apply the WHT-aware layer.
     *
     * Reads:
     *   - the WHT rate from the Cash App Transaction record
     *   - the regime *display label* from the linked batch setup
     *
     * Returns { regime: null, rate: null } when either piece is missing
     * so the matcher falls back to legacy unpaid-balance summation.
     *
     * @param {number|string} cashAppTransactionId
     * @returns {{ regime: (string|null), rate: (number|null) }}
     */
    function lookupWhtContextForTransaction(cashAppTransactionId) {
        const fn = `${MODULE}.lookupWhtContextForTransaction`

        try {
            // search.lookupFields only supports a single join level, but the regime
            // lives two joins away (Transaction → Batch → Setup → WHT Regime).
            // SuiteQL handles the chained joins natively, so use it for the regime
            // and keep lookupFields for the rate that lives on the transaction itself.
            const sql = `
                SELECT
                    ct.custrecord_tb_wht_rate AS rate,
                    BUILTIN.DF(cash_app_setup.custrecord_tb_wht_regime) AS regime
                FROM customrecord_pri_cashapp_transaction AS ct
                LEFT JOIN customrecord_pri_cashapp_batch  AS cash_app_batch
                    ON ct.custrecord_pri_cashapp_trans_batch = cash_app_batch.id
                LEFT JOIN customrecord_pri_cashapp_setup  AS cash_app_setup
                    ON cash_app_batch.custrecord_pri_cashapp_batch_setup = cash_app_setup.id
                WHERE ct.id = ?
            `
            const rows = query.runSuiteQL({
                query:  sql,
                params: [cashAppTransactionId]
            }).asMappedResults()

            if (!rows.length) {
                log.debug(fn, `No row returned for Cash App Transaction ${cashAppTransactionId}`)
                return { regime: null, rate: null }
            }

            const rate = parseFloat(rows[0].rate)
            const regime = rows[0].regime || null

            return {
                regime: regime,
                rate:   isNaN(rate) ? null : rate
            }
        } catch (err) {
            log.error(fn, `Failed to look up WHT context for transaction ${cashAppTransactionId}: ${err.message}`)
            return { regime: null, rate: null }
        }
    }

    /**
     * Ensures custrecord_pri_cashapp_trans_customer is populated before the
     * bundle's moveBalance functions are called.
     *
     * lookupCashAppTransaction (inside PRI_CashApp_Common) derives customerRecordId
     * exclusively from custrecord_pri_cashapp_trans_customer. If only the suggested
     * customer field (custrecord_pri_cashapp_suggested_cust) is set, the bundle
     * function will receive a null customer and silently fail to create the payment
     * or deposit. This helper detects that situation and promotes the suggested
     * customer to the actual customer field before proceeding.
     *
     * @param {number|string} cashAppTranId
     * @returns {string|null} the customer ID that will be used, or null if neither field is set
     */
    function ensureCustomerIsSet(cashAppTranId) {
        const fn = `${MODULE}.ensureCustomerIsSet`

        const lookup = search.lookupFields({
            type: 'customrecord_pri_cashapp_transaction',
            id:   cashAppTranId,
            columns: [
                'custrecord_pri_cashapp_trans_customer',
                'custrecord_pri_cashapp_suggested_cust'
            ]
        })

        const customer = lookup.custrecord_pri_cashapp_trans_customer
            && lookup.custrecord_pri_cashapp_trans_customer[0]
            && lookup.custrecord_pri_cashapp_trans_customer[0].value
            || null

        const suggestedCust = lookup.custrecord_pri_cashapp_suggested_cust
            && lookup.custrecord_pri_cashapp_suggested_cust[0]
            && lookup.custrecord_pri_cashapp_suggested_cust[0].value
            || null

        if (customer) {
            log.debug(fn, `Customer already set to ${customer} on transaction ${cashAppTranId}`)
            return customer
        }

        if (!suggestedCust) {
            log.debug(fn, `No customer or suggested customer found on transaction ${cashAppTranId}`)
            return null
        }

        log.audit(fn, `Promoting suggested customer ${suggestedCust} → custrecord_pri_cashapp_trans_customer on transaction ${cashAppTranId}`)
        record.submitFields({
            type:   'customrecord_pri_cashapp_transaction',
            id:     cashAppTranId,
            values: { custrecord_pri_cashapp_trans_customer: suggestedCust }
        })

        return suggestedCust
    }

    /**
     * Moves the remaining dummy-payment balance to a real Customer Payment for
     * the transaction's assigned customer.
     * Wraps cashApp.moveBalanceToCustomer from PRI_CashApp_Common.
     *
     * Before delegating to the bundle, ensures custrecord_pri_cashapp_trans_customer
     * is set — promoting custrecord_pri_cashapp_suggested_cust if needed — because
     * lookupCashAppTransaction (inside the bundle) only reads the former field.
     *
     * @param {number|string} cashAppTranId
     * @param {boolean}       [consolidate=true] — see consolidate explanation in
     *                        processMovBalanceToCustomer controller doc
     * @returns {Object}
     */
    function moveBalanceToCustomer(cashAppTranId, consolidate, newMemo) {
        const fn = `${MODULE}.moveBalanceToCustomer`
        log.audit(fn, `Moving balance to customer for Cash App Transaction ${cashAppTranId}`)

        if (newMemo !== undefined && newMemo !== null) {
            record.submitFields({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId,
                values: { custrecord_pri_cashapp_trans_memo: newMemo }
            })
            log.debug(fn, `Updated custrecord_pri_cashapp_trans_memo to "${newMemo}"`)
        }

        const customerId = ensureCustomerIsSet(cashAppTranId)
        if (!customerId) {
            throw new Error(`Cannot move balance: no customer or suggested customer is set on Cash App Transaction ${cashAppTranId}`)
        }

        const warnings = []
        let paymentId = null

        const shouldConsolidate = consolidate !== false
        try {
            paymentId = cashApp.moveBalanceToCustomer(cashAppTranId, shouldConsolidate)
        } catch (moveErr) {
            log.error(fn, `moveBalanceToCustomer threw: ${moveErr.message}. ${moveErr.stack || ''}`)
            warnings.push(`Move balance failed: ${moveErr.message}`)
        }

        const cleanupErr = cleanUpPhantomDummyAfterMove(cashAppTranId)
        if (cleanupErr) warnings.push(cleanupErr)

        const postWarnings = getPostOperationWarnings(cashAppTranId)
        warnings.push.apply(warnings, postWarnings)

        const finalStatusLookup = search.lookupFields({
            type: 'customrecord_pri_cashapp_transaction',
            id: cashAppTranId,
            columns: ['custrecord_pri_cashapp_trans_matchstatus']
        })
        const finalStatusArr = finalStatusLookup.custrecord_pri_cashapp_trans_matchstatus
        const finalStatus = finalStatusArr && finalStatusArr[0] && finalStatusArr[0].value || null
        const finalStatusText = finalStatusArr && finalStatusArr[0] && finalStatusArr[0].text || null

        const isFullyApplied = finalStatus === cashApp.MATCH_STATUS.APPLIED_FULL
        const isPartiallyApplied = finalStatus === cashApp.MATCH_STATUS.APPLIED_PARTIAL
        const isManual = finalStatus === cashApp.MATCH_STATUS.MANUAL
        const applySucceeded = isFullyApplied || isPartiallyApplied || isManual

        if (!applySucceeded) {
            log.error(fn, `moveBalanceToCustomer ${cashAppTranId} failed. Status: ${finalStatus}. Warnings: ${JSON.stringify(warnings)}`)
        } else if (warnings.length) {
            log.error(fn, `moveBalanceToCustomer ${cashAppTranId} completed${isPartiallyApplied ? ' (partial)' : ''} with warnings: ${JSON.stringify(warnings)}`)
        } else {
            log.audit(fn, `Successfully moved balance for Cash App Transaction ${cashAppTranId}${isPartiallyApplied ? ' (partial)' : ''}, paymentId: ${paymentId}`)
        }

        return {
            cashAppTranId:   parseInt(cashAppTranId),
            paymentId:       paymentId ? parseInt(paymentId) : null,
            applied:         applySucceeded,
            partialApply:    isPartiallyApplied,
            matchStatus:     finalStatus,
            matchStatusText: finalStatusText,
            warnings:        warnings.length > 0 ? warnings : undefined,
            message:         !applySucceeded
                ? 'Move balance to customer payment failed'
                : isPartiallyApplied
                    ? 'Balance moved to customer payment (partial apply)'
                    : 'Balance moved to customer payment successfully'
        }
    }

    /**
     * Moves the remaining dummy-payment balance to a Customer Deposit for
     * the transaction's assigned customer.
     * Wraps cashApp.moveBalanceToCustomerDeposit from PRI_CashApp_Common.
     *
     * Same customer-promotion pre-step as moveBalanceToCustomer.
     *
     * @param {number|string} cashAppTranId
     * @returns {Object}
     */
    function moveBalanceToCustomerDeposit(cashAppTranId, newMemo) {
        const fn = `${MODULE}.moveBalanceToCustomerDeposit`
        log.audit(fn, `Moving balance to customer deposit for Cash App Transaction ${cashAppTranId}`)

        if (newMemo !== undefined && newMemo !== null) {
            record.submitFields({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId,
                values: { custrecord_pri_cashapp_trans_memo: newMemo }
            })
            log.debug(fn, `Updated custrecord_pri_cashapp_trans_memo to "${newMemo}"`)
        }

        const customerId = ensureCustomerIsSet(cashAppTranId)
        if (!customerId) {
            throw new Error(`Cannot move balance: no customer or suggested customer is set on Cash App Transaction ${cashAppTranId}`)
        }

        const warnings = []
        let depositId = null

        try {
            depositId = cashApp.moveBalanceToCustomerDeposit(cashAppTranId)
        } catch (moveErr) {
            log.error(fn, `moveBalanceToCustomerDeposit threw: ${moveErr.message}. ${moveErr.stack || ''}`)
            warnings.push(`Move balance to deposit failed: ${moveErr.message}`)
        }

        const cleanupErr = cleanUpPhantomDummyAfterMove(cashAppTranId)
        if (cleanupErr) warnings.push(cleanupErr)

        const postWarnings = getPostOperationWarnings(cashAppTranId)
        warnings.push.apply(warnings, postWarnings)

        const finalStatusLookup = search.lookupFields({
            type: 'customrecord_pri_cashapp_transaction',
            id: cashAppTranId,
            columns: ['custrecord_pri_cashapp_trans_matchstatus']
        })
        const finalStatusArr = finalStatusLookup.custrecord_pri_cashapp_trans_matchstatus
        const finalStatus = finalStatusArr && finalStatusArr[0] && finalStatusArr[0].value || null
        const finalStatusText = finalStatusArr && finalStatusArr[0] && finalStatusArr[0].text || null

        const isFullyApplied = finalStatus === cashApp.MATCH_STATUS.APPLIED_FULL
        const isPartiallyApplied = finalStatus === cashApp.MATCH_STATUS.APPLIED_PARTIAL
        const isManual = finalStatus === cashApp.MATCH_STATUS.MANUAL
        const applySucceeded = isFullyApplied || isPartiallyApplied || isManual

        if (!applySucceeded) {
            log.error(fn, `moveBalanceToCustomerDeposit ${cashAppTranId} failed. Status: ${finalStatus}. Warnings: ${JSON.stringify(warnings)}`)
        } else if (warnings.length) {
            log.error(fn, `moveBalanceToCustomerDeposit ${cashAppTranId} completed${isPartiallyApplied ? ' (partial)' : ''} with warnings: ${JSON.stringify(warnings)}`)
        } else {
            log.audit(fn, `Successfully moved balance for Cash App Transaction ${cashAppTranId}${isPartiallyApplied ? ' (partial)' : ''}, depositId: ${depositId}`)
        }

        return {
            cashAppTranId:   parseInt(cashAppTranId),
            depositId:       depositId ? parseInt(depositId) : null,
            applied:         applySucceeded,
            partialApply:    isPartiallyApplied,
            matchStatus:     finalStatus,
            matchStatusText: finalStatusText,
            warnings:        warnings.length > 0 ? warnings : undefined,
            message:         !applySucceeded
                ? 'Move balance to customer deposit failed'
                : isPartiallyApplied
                    ? 'Balance moved to customer deposit (partial apply)'
                    : 'Balance moved to customer deposit successfully'
        }
    }

    /**
     * Voids a Cash App Transaction and all its associated customer payments.
     * Delegates entirely to applyTxnSL.taboolaVoid (PRI_CashApp_SL_ApplyTransaction),
     * which: voids each payment via the ACS void suitelet, sets the transaction
     * status to ELIMINATED, zeroes the amount, and re-runs batch control totals.
     *
     * @param {number|string} cashAppTranId
     * @returns {Object}
     */
    function voidCashAppTransaction(cashAppTranId) {
        const fn = `${MODULE}.voidCashAppTransaction`
        log.debug(fn, `Voiding Cash App Transaction ${cashAppTranId}`)

        const warnings = []

        try {
            applyTxnSL.taboolaVoid(cashAppTranId)
        } catch (voidErr) {
            log.error(fn, `taboolaVoid threw: ${voidErr.message}. ${voidErr.stack || ''}`)
            warnings.push(`Void failed: ${voidErr.message}`)
        }

        const postWarnings = getPostOperationWarnings(cashAppTranId)
        warnings.push.apply(warnings, postWarnings)

        let isZeroed = false
        try {
            const voidLookup = search.lookupFields({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId,
                columns: ['custrecord_pri_cashapp_trans_amount']
            })
            isZeroed = parseFloat(voidLookup.custrecord_pri_cashapp_trans_amount) === 0
        } catch (lookupErr) {
            log.error(fn, `Post-void amount check failed: ${lookupErr.message}`)
        }

        const voided = isZeroed

        if (warnings.length) {
            log.error(fn, `voidCashAppTransaction ${cashAppTranId} completed with warnings: ${JSON.stringify(warnings)}`)
        } else {
            log.audit(fn, `Successfully voided Cash App Transaction ${cashAppTranId}`)
        }

        return {
            cashAppTranId: parseInt(cashAppTranId),
            voided:        voided,
            warnings:      warnings.length > 0 ? warnings : undefined,
            message:       !voided
                ? 'Cash App Transaction void failed'
                : warnings.length > 0
                    ? 'Cash App Transaction void completed with warnings'
                    : 'Cash App Transaction and associated payments voided successfully'
        }
    }

    /**
     * Creates a Cash Sale (India prepayment) for the transaction's assigned customer.
     * Splits the dummy-payment balance into base + GST item lines on a cash sale.
     *
     * @param {number|string} cashAppTranId
     * @returns {Object}
     */
    function cashSalePrepayment(cashAppTranId, newMemo) {
        const fn = `${MODULE}.cashSalePrepayment`
        log.audit(fn, `Creating cash sale prepayment for Cash App Transaction ${cashAppTranId}`)

        if (newMemo !== undefined && newMemo !== null) {
            record.submitFields({
                type: 'customrecord_pri_cashapp_transaction',
                id: cashAppTranId,
                values: { custrecord_pri_cashapp_trans_memo: newMemo }
            })
            log.debug(fn, `Updated custrecord_pri_cashapp_trans_memo to "${newMemo}"`)
        }

        const customerId = ensureCustomerIsSet(cashAppTranId)
        if (!customerId) {
            throw new Error(`Cannot create cash sale prepayment: no customer or suggested customer is set on Cash App Transaction ${cashAppTranId}`)
        }

        const warnings = []
        let cashSaleId = null

        try {
            cashSaleId = cashApp.cashSalePrepayment(cashAppTranId)
        } catch (err) {
            log.error(fn, `cashSalePrepayment threw: ${err.message}. ${err.stack || ''}`)
            warnings.push(`Cash sale prepayment failed: ${err.message}`)
        }

        const cleanupErr = cleanUpPhantomDummyAfterMove(cashAppTranId)
        if (cleanupErr) warnings.push(cleanupErr)

        const postWarnings = getPostOperationWarnings(cashAppTranId)
        warnings.push.apply(warnings, postWarnings)

        const finalStatusLookup = search.lookupFields({
            type: 'customrecord_pri_cashapp_transaction',
            id: cashAppTranId,
            columns: ['custrecord_pri_cashapp_trans_matchstatus']
        })
        const finalStatusArr = finalStatusLookup.custrecord_pri_cashapp_trans_matchstatus
        const finalStatus = finalStatusArr && finalStatusArr[0] && finalStatusArr[0].value || null
        const finalStatusText = finalStatusArr && finalStatusArr[0] && finalStatusArr[0].text || null

        const isManual = finalStatus === cashApp.MATCH_STATUS.MANUAL
        const applySucceeded = isManual || finalStatus === cashApp.MATCH_STATUS.APPLIED_FULL

        if (!applySucceeded) {
            log.error(fn, `cashSalePrepayment ${cashAppTranId} failed. Status: ${finalStatus}. Warnings: ${JSON.stringify(warnings)}`)
        } else if (warnings.length) {
            log.error(fn, `cashSalePrepayment ${cashAppTranId} completed with warnings: ${JSON.stringify(warnings)}`)
        } else {
            log.audit(fn, `Successfully created cash sale prepayment for Cash App Transaction ${cashAppTranId}, cashSaleId: ${cashSaleId}`)
        }

        return {
            cashAppTranId:   parseInt(cashAppTranId),
            cashSaleId:      cashSaleId ? parseInt(cashSaleId) : null,
            applied:         applySucceeded,
            matchStatus:     finalStatus,
            matchStatusText: finalStatusText,
            warnings:        warnings.length > 0 ? warnings : undefined,
            message:         !applySucceeded
                ? 'Cash sale prepayment failed'
                : 'Cash sale prepayment created successfully'
        }
    }

    return {
        getMatchData:                getMatchData,
        applyMatchData:              applyMatchData,
        suggestInvoices:             suggestInvoices,
        moveBalanceToCustomer:       moveBalanceToCustomer,
        moveBalanceToCustomerDeposit: moveBalanceToCustomerDeposit,
        cashSalePrepayment:          cashSalePrepayment,
        voidCashAppTransaction:      voidCashAppTransaction
    }
})
