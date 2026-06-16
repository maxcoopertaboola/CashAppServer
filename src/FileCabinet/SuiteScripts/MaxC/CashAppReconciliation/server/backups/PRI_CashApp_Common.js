//-----------------------------------------------------------------------------------------------------------
// Copyright 2024, All rights reserved, Prolecto Resources, Inc.
//
// No part of this file may be copied or used without express, written permission of Prolecto Resources, Inc.
//-----------------------------------------------------------------------------------------------------------
//-----------------------------------------------------------------------------------------------------------
// Description: Cash Application Common Library
//-----------------------------------------------------------------------------------------------------------
// Version History
// 20240328 Jeff Dennis PTM20064
// 20240611 Jeff Dennis PTM21160 - Modified file to support BAI2 and BAILockbox file formats (from RIEM)
// 20240801 Jeff Dennis PTM21160 - Modified file to support auto-application of cash to open invoices from
//                                 different customer records.
// 20241008 Jeff Dennis PTM22804 - Modified file to address occasional bug where IDs were getting cast as a float.
// 20241011 Jeff Dennis PTM22811 - Fixed issue with underpayment write-offs not being created correctly.
// 20241018 Jeff Dennis PTM22811 - Added retry logic for overpayment write-offs in the event of a match not being found.
// 20250723 Jeff Dennis PTM23152 - Added a serial number to the transaction record to check for duplicates.
// 20250926 Jeff Dennis PTM24443 - Updated for CashApp backups.
// 20251022 Jeff Dennis PTM26433 - Added CashApp Backup AI data processing methods.
// 20251212 Jeff Dennis PTM26433 - Added multi-currency support and AI Backup support.
// 20260311 Jeff Dennis PTM28554 - Universal Date format support
// 20260317 Jeff Dennis PTM28554 - Added WHT Support.
//
//-----------------------------------------------------------------------------------------------------------

/**
 * @NApiVersion 2.1
 * @NModuleScope Public
 */
define([
    'N/log', 'N/runtime', 'N/cache', 'N/config', 'N/crypto', 'N/encode', 'N/file',
    'N/llm', 'N/plugin', 'N/query', 'N/record', 'N/search', 'N/task', 'N/url',
    '/.bundle/132118/PRI_AS_Engine21', '/.bundle/132118/PRI_CommonLibrary21',
], (log, runtime, cache, config, crypto, encode, file, llm, plugin, suiteQL, record, search, task, url, asEngine, priCommon) => {
    const scriptName = 'PRI_CashApp_Common'

    const PRI_CASHAPP_CACHE_KEY = 'PRI_CashApp'

    /* ====================================================================================================== */
    //#region Enums

    const BATCH_STATUS = {
        NOT_PROCESSED: '1',
        PROCESSED: '2',
        IN_PROGRESS: '3'
    }

    const MATCH_STATUS = {
        NOT_MATCHED: '1',
        REVIEW: '2',
        APPLIED_PARTIAL: '3',
        APPLIED_FULL: '4',
        // Taboola Cash App Transaction - Custom Match Statuses
        MANUAL: '5',
        ELIMINATED: '6'
    }

    const MATCH_ISSUE = {
        NO_MATCH_FOUND: '1',
        NO_MATCHING_TOTAL_FOUND: '2',
        MATCHING_PAID_TRANSACTION: '3',
        MULTIPLE_MATCHING_CUSTOMERS: '4',
        MATCHING_TOTAL_FOUND: '5',
        MULTIPLE_MATCHING_TOTALS_FOUND: '6',
        // Taboola Cash App Transaction - Custom Match Issues
        MATCHING_PAID_FUZZY_TRANSACTION: '7'
    }
    
    //#endregion Enums
    /* ====================================================================================================== */

    const MEMO_MAX_LEN = 299
    function truncMemo(v) { return v && v.length > MEMO_MAX_LEN ? v.substring(0, MEMO_MAX_LEN) : v }

    /* ====================================================================================================== */
    //#region Config/Setup Methods

    function lookupCashAppSetupByBatch(cashAppBatchId) {
        if (!cashAppBatchId) 
            return null
        const lookup = search.lookupFields({
            id:cashAppBatchId,
            type:'customrecord_pri_cashapp_batch',
            columns:[
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_subsidiary',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_location',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_undepfunds',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_cashaccount',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_araccount',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_writeoffamt',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffdebit',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffcredit',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffbank',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffbankcr',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffmemo',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffrectyp',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_currency',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_fx_account',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_dummycust',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_paymethod',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_plugindata',
                'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_ai_back_ins',
                'custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_regime',
                'custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_account',
                'custrecord_pri_cashapp_batch_setup.custrecord_tb_last_year_wht_account',
                'custrecord_pri_cashapp_batch_setup.custrecord_tb_default_payment_form'
            ]
        })
        if (!lookup) 
            return null

        const data = {}
        data.defaultSubsidiary = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_subsidiary'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_subsidiary'][0].value
            || null
        data.defaultLocation = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_location'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_location'][0].value
            || null
        data.undepositedFunds = lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_undepfunds']
        data.undepositedFunds = data.undepositedFunds === true || data.undepositedFunds === 'T'
        data.dummyCustomer = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_dummycust'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_dummycust'][0].value
            || null
        data.cashAccount = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_cashaccount'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_cashaccount'][0].value
            || null
        data.arAccount = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_araccount'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_araccount'][0].value
            || null
        data.writeOffThreshold = !isNaN(parseFloat(lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_writeoffamt']))
            && parseFloat(lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_writeoffamt'])
            || 0
        data.writeOffDebitAccount = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffdebit'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffdebit'][0].value
            || null
        data.writeOffCreditAccount = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffcredit'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffcredit'][0].value
            || null
        data.writeOffBankFeeAccount = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffbank'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffbank'][0].value
            || null
        data.writeOffBankFeeCreditAccount = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffbankcr'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffbankcr'][0].value
            || null
        data.defaultCurrency = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_currency'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_currency'][0].value
            || null
        data.defaultCurrencyName = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_currency'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_currency'][0].text
            || null
        data.fxDebitAccount = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_fx_account'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_fx_account'][0].value
            || null
        data.writeOffMemo = lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffmemo']
        data.writeOffRecordType = lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_wtoffrectyp']
        data.paymentMethod = !!lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_paymethod'][0]
            && lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_paymethod'][0].value
            || null
        data.pluginData = lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_plugindata']
        try { data.pluginData = JSON.parse(data.pluginData) } catch(err) {}
        data.aiBackupInstructions = lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_ai_back_ins']
        data.taboolaWHTRegime = lookup['custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_regime']?.[0]?.value
        data.taboolaWHTAccount = lookup['custrecord_pri_cashapp_batch_setup.custrecord_tb_wht_account']?.[0]?.value
        // India WHT only: account for additional WHT payments applied to invoices dated
        // before April 1 of the current Indian fiscal year (01.04.YYYY – 31.03.YYYY+1).
        // Optional; null when the setup hasn't configured a previous-year override.
        data.taboolaLastYearWHTAccount = lookup['custrecord_pri_cashapp_batch_setup.custrecord_tb_last_year_wht_account']?.[0]?.value || null
        // Optional custom form id to use when creating customer payments (apply,
        // move-to-customer, dummy/remainder). When unset, NetSuite picks the user's
        // default form and existing behavior is preserved.
        data.defaultPaymentForm = lookup['custrecord_pri_cashapp_batch_setup.custrecord_tb_default_payment_form']?.[0]?.value || null
        return data
    }

    function queryCashAppSetupRecord(bankId) {
        const fn = `${scriptName}.queryCashAppSetupRecord: ${bankId}`
        log.debug(fn, 'start')
        try {
            const results = runQuery(`
                SELECT 
                    s.id,
                    s.custrecord_pri_cashapp_setup_filetype AS filetype,
                    s.custrecord_pri_cashapp_setup_bankid AS bankid,
                    s.custrecord_pri_cashapp_setup_plugin AS plugin,
                FROM customrecord_pri_cashapp_setup AS s
                WHERE s.custrecord_pri_cashapp_setup_bankid = '${bankId}'
                    AND s.isinactive = 'F'
                ORDER by s.id DESC
            `)
            log.debug(`${fn}: Results found`, results.length)
            return results.length > 0 && results[0] || null
        } catch (err) {
            log.error(`${fn}: ${err.name}`, err.message)
            return null
        }
    }

    //#endregion Config/Setup Methods
    /* ====================================================================================================== */
    //#region Batch Methods

    function getCashAppBatches(json) {
        const fn = `${scriptName}.getCashAppBatches`
        if (!json instanceof Object || !json.hasOwnProperty('FileHeader') || !json.hasOwnProperty('FileTrailer')) {
            log.error(`${fn}: The parameter \'json\' is not a valid BAI2 or BAILockbox JSON object.`, JSON.stringify(json))
            return []
        }

        const batches = []
        for (const Batch of json.Groups) {
            if (!Batch instanceof Object || !Batch.hasOwnProperty('GroupHeader') 
            || !Batch.hasOwnProperty('Accounts') || !Batch.hasOwnProperty('GroupTrailer')) {
                log.error(`${fn}: The current Batch is not a valid BAI2 Group JSON object.`, JSON.stringify(Batch))
                continue
            }
            Batch.FileType = json.FileType
            Batch.FileHeader = json.FileHeader
            Batch.FileTrailer = json.FileTrailer
            batches.push(Batch)
        }

        return batches
    }

    function createCashAppBatch(batchData, sourceRecId, sourceRecType) {
        const fn = `${scriptName}.createCashAppBatch`
        
        let rec = record.create({type:'customrecord_pri_cashapp_batch'})

        let date = null,
            bankId = null

        if (batchData.FileType == 'BAILockbox') {
            if (batchData.hasOwnProperty('BatchHeader')) {
                date = formatDate({yymmdd:batchData.BatchHeader.depositDate})
                bankId = batchData.BatchHeader.lockboxNumber || ''
            } else {
                if (batchData.GroupHeader.hasOwnProperty('depositDate'))
                    date = formatDate({yymmdd:batchData.GroupHeader.depositDate})
                bankId = batchData.GroupHeader.lockboxNumber || ''
            }
        } else if (batchData.FileType == 'CSV') {
            date = formatDate({yyyymmdd:batchData.GroupHeader.asOfDate})
            bankId = batchData.GroupHeader.bankId || ''
            log.debug(`${fn}: CSV FileType`, {asOfDate:batchData.GroupHeader.asOfDate, date, bankId})
        } else if (batchData.FileType == 'BAI2' || !batchData.FileType) {
            date = formatDate({yymmdd:batchData.GroupHeader.asofDate})
            bankId = batchData.GroupHeader.bankId || ''
        }

        const setupRecord = queryCashAppSetupRecord(bankId)
        if (!setupRecord) {
            throw new Error(`${fn}: No setup record found for bankId ${bankId}`)
        }

        rec.setValue({fieldId:'custrecord_pri_cashapp_batch_date', value:date})
        rec.setValue({fieldId:'custrecord_pri_cashapp_batch_data', value:JSON.stringify(batchData)})
        rec.setValue({fieldId:'custrecord_pri_cashapp_batch_bankid', value:bankId})
        rec.setValue({fieldId:'custrecord_pri_cashapp_batch_setup', value:setupRecord.id})

        // Set the source record id, type & url
        if (!!sourceRecId)
            rec.setValue({fieldId:'custrecord_pri_cashapp_batch_srcrecid', value:sourceRecId})
        if (!!sourceRecType)
            rec.setValue({fieldId:'custrecord_pri_cashapp_batch_srcrectype', value:sourceRecType})
        if (!!sourceRecId && !!sourceRecType) {
            try {
                const domain = url.resolveDomain({ hostType:url.HostType.APPLICATION, accountId:runtime.accountId }),
                    fragment = url.resolveRecord({ recordId:sourceRecId, recordType:sourceRecType })
                rec.setValue({fieldId:'custrecord_pri_cashapp_batch_srcrecurl', value:`https://${domain}${fragment}`})
            } catch (err) {
                const { name, message } = err
                log.error(`${fn}: Failed to format URL`, JSON.stringify({ name, message }))
            }
        }

        const batchId = rec.save()
        log.audit(fn, `PRI CashApp Batch created. ID ${batchId}`)

        return batchId
    }
    
    /**
     * @see PRI_CashApp_MR_BatchProcessor.map
     * 
     * @param {number} batchId - The ID of the batch to set to in progress
     * @returns {number} The ID of the batch
     */
    function setBatchImportInProgress(batchId) {
        const fn = `${scriptName}.setBatchImportInProgress`
        log.debug(fn, batchId)
        record.submitFields({
            type:'customrecord_pri_cashapp_batch',
            id:batchId,
            values:{ 'custrecord_pri_cashapp_batch_status':BATCH_STATUS.IN_PROGRESS }
        })
        return batchId
    }

    /**
     * @see PRI_CashApp_MR_BatchProcessor.summarize
     * 
     * @param {number} batchId - The ID of the batch to set the totals for
     * @param {number} totalRecords - The total number of records in the batch
     * @param {number} totalAmount - The total amount of the batch
     * @returns {number} The ID of the batch
     */
    function setCashAppBatchControlTotals(batchId, totalRecords, totalAmount) {
        record.submitFields({
            type:'customrecord_pri_cashapp_batch',
            id:batchId,
            values:{
                'custrecord_pri_cashapp_batch_payments':totalRecords,
                'custrecord_pri_cashapp_batch_amount':totalAmount
            }
        })
        return batchId
    }

    /**
     * @see PRI_CashApp_MR_TransactionMatch.summarize
     * 
     * @param {number} batchId - The ID of the batch to set to processed
     * @returns {number} The ID of the batch
     */
    function setBatchImportProcessed(batchId) {
        const fn = `${scriptName}.setBatchImportProcessed`
        record.submitFields({
            type:'customrecord_pri_cashapp_batch',
            id:batchId,
            values:{ 'custrecord_pri_cashapp_batch_status':BATCH_STATUS.PROCESSED }
        })
        return batchId
    }

    //#endregion Batch Methods
    /* ====================================================================================================== */
    //#region Transaction Methods

    /**
     * @see PRI_CashApp_MR_BatchProcessor.map
     * 
     * @param {number} batchId - The ID of the batch to get the transactions for
     * @param {Object} batchData - The batch data
     * @param {number} configId - The ID of the configuration to use
     * @returns {Object[]} The transactions
     */
    function getCashAppTransactions(batchId, batchData, configId) {
        const fn = `${scriptName}.getCashAppTransactions, Batch ${batchId}`
        if (!batchData instanceof Object || !batchData.hasOwnProperty('FileType')) {
            log.error(fn, JSON.stringify({
                error:'The parameter \'batchData\' is not a valid Batch object.', batchId, batchData}))
            return []
        }

        let transactions = []
        if (batchData.FileType == 'BAILockbox') {
            if (batchData.hasOwnProperty('Transactions') && Array.isArray(batchData.Transactions) && batchData.Transactions.length) {
                for (const t of batchData.Transactions)
                    transactions.push(t)
            }
        } else if (batchData.FileType == 'BAI2') {
            for (const a of batchData.Accounts) {
                if (!a.hasOwnProperty('Transactions') || !Array.isArray(a.Transactions) || !a.Transactions.length)
                    continue
                for (const t of a.Transactions) {
                    t.AccountHeader = a.AccountHeader
                    transactions.push(t)
                }
            }
        } else if (batchData.FileType == 'CSV') {
            if (batchData.hasOwnProperty('Transactions') && Array.isArray(batchData.Transactions) && batchData.Transactions.length) {
                for (const t of batchData.Transactions)
                    transactions.push(t)
            }
        }  

        // Filter our any negated matching rules
        log.debug(fn, `Config: ${configId}`)
        if (!!configId) {
            const negatedRules = getNegatedMatchingRules(configId)
            transactions = filterTransactionsByNegatedRules(transactions, negatedRules)
        }

        // Try to load the plugin. If it fails, return the default transaction listed
        let plugin = null
        let pluginData = {}
        try {
            const pl = getPlugin(batchId)
            plugin = pl.plugin
            pluginData = pl.pluginData
        } catch(e) {
            log.error(fn, `Failed to get plugin. ${e.message}. ${e.stack}`)
        }
        if (!!plugin) {
            log.debug(`${fn}: plugin data`, JSON.stringify(pluginData))
            try {
                const pluginTransactions = plugin.getCashAppTransactions(batchId, batchData, transactions, pluginData)
                return pluginTransactions || transactions
            } catch (err) {
                log.error(fn, `Failed to call Plugin method getCashAppTransactions. ${err.message}`)
                return transactions
            }
        }
        return transactions
    }

    function lookupCashAppTransaction(cashAppTranId) {
        const lookup = search.lookupFields({
            type:'customrecord_pri_cashapp_transaction',
            id:cashAppTranId,
            columns:[
                'custrecord_pri_cashapp_trans_batch',
                'custrecord_pri_cashapp_trans_batch.custrecord_pri_cashapp_batch_setup',
                'custrecord_pri_cashapp_trans_sequence_no',
                'custrecord_pri_cashapp_trans_date',
                'custrecord_pri_cashapp_trans_amount',
                'custrecord_pri_cashapp_trans_bankfee',
                'custrecord_pri_cashapp_trans_bankfeetxn',
                'custrecord_pri_cashapp_trans_foreignamt',
                'custrecord_pri_cashapp_trans_foreigncur',
                // Taboola Cash App Transaction - Editable Exchange Rate
                'custrecord_pri_cashapp_trans_exchrate',
                'custrecord_pri_cashapp_trans_matchstatus',
                'custrecord_pri_cashapp_trans_paymethod',
                'custrecord_pri_cashapp_trans_check_no',
                'custrecord_pri_cashapp_trans_cust_name',
                'custrecord_pri_cashapp_trans_cust_id',
                'custrecord_pri_cashapp_trans_customer',
                'custrecord_pri_cashapp_trans_location',
                'custrecord_pri_cashapp_trans_memo',
                'custrecord_pri_cashapp_trans_details',
                'custrecord_pri_cashapp_trans_dummypymt',
                'custrecord_pri_cashapp_trans_matchissues',
                'custrecord_pri_cashapp_trans_matches',
                'custrecord_pri_cashapp_trans_data',
                'custrecord_pri_cashapp_trans_fxwriteoff',
            ]
        })

        const data = {}
        if (!lookup) return data

        data.batchId = !!lookup.custrecord_pri_cashapp_trans_batch[0]
            && parseInt(lookup.custrecord_pri_cashapp_trans_batch[0].value) || null
        data.sequenceNo = !isNaN(parseInt(lookup.custrecord_pri_cashapp_trans_sequence_no))
            && parseInt(lookup.custrecord_pri_cashapp_trans_sequence_no) || 0
        data.date = lookup.custrecord_pri_cashapp_trans_date
        data.paymentAmount = !isNaN(parseFloat(lookup.custrecord_pri_cashapp_trans_amount))
            && parseFloat(lookup.custrecord_pri_cashapp_trans_amount) || 0
        data.matchStatus = lookup.custrecord_pri_cashapp_trans_matchstatus[0]
        data.paymentMethod = lookup.custrecord_pri_cashapp_trans_paymethod[0]
        data.checkNo = lookup.custrecord_pri_cashapp_trans_check_no
        data.customerName = lookup.custrecord_pri_cashapp_trans_cust_name
        data.customerId = lookup.custrecord_pri_cashapp_trans_cust_id
        data.customerRecordId = !!lookup.custrecord_pri_cashapp_trans_customer
            && lookup.custrecord_pri_cashapp_trans_customer.length
            && lookup.custrecord_pri_cashapp_trans_customer[0].value
            || null
        data.location = !!lookup.custrecord_pri_cashapp_trans_location
            && lookup.custrecord_pri_cashapp_trans_location.length
            && lookup.custrecord_pri_cashapp_trans_location[0].value
            || null
        data.memo = lookup.custrecord_pri_cashapp_trans_memo
        data.details = lookup.custrecord_pri_cashapp_trans_details
        data.dummyPayment = !!lookup.custrecord_pri_cashapp_trans_dummypymt[0]
            && lookup.custrecord_pri_cashapp_trans_dummypymt[0].value !== ''
            && parseInt(lookup.custrecord_pri_cashapp_trans_dummypymt[0].value) || null
        data.bankFee = !isNaN(parseFloat(lookup.custrecord_pri_cashapp_trans_bankfee))
            && parseFloat(lookup.custrecord_pri_cashapp_trans_bankfee) || 0
        data.bankFeeWriteOff = !!lookup.custrecord_pri_cashapp_trans_bankfeetxn[0]
            && lookup.custrecord_pri_cashapp_trans_bankfeetxn[0].value !== ''
            && parseInt(lookup.custrecord_pri_cashapp_trans_bankfeetxn[0].value) || null
        data.foreignRemitAmount = !isNaN(parseFloat(lookup.custrecord_pri_cashapp_trans_foreignamt))
            && parseFloat(lookup.custrecord_pri_cashapp_trans_foreignamt) || 0
        data.foreignCurrency = !!lookup.custrecord_pri_cashapp_trans_foreigncur?.[0]
            && lookup.custrecord_pri_cashapp_trans_foreigncur[0].value
            || null
        data.foreignCurrencyName = !!lookup.custrecord_pri_cashapp_trans_foreigncur?.[0]
            && lookup.custrecord_pri_cashapp_trans_foreigncur[0].text
            || null
        // Taboola Cash App Transaction - Editable Exchange Rate
        data.exchangeRate = !isNaN(parseFloat(lookup.custrecord_pri_cashapp_trans_exchrate))
            && parseFloat(lookup.custrecord_pri_cashapp_trans_exchrate) || 0
        data.fxWriteOff = !!lookup.custrecord_pri_cashapp_trans_fxwriteoff[0]
            && lookup.custrecord_pri_cashapp_trans_fxwriteoff[0].value !== ''
            && parseInt(lookup.custrecord_pri_cashapp_trans_fxwriteoff[0].value) || null
        data.matchIssues = lookup.custrecord_pri_cashapp_trans_matchissues
        data.matches = lookup.custrecord_pri_cashapp_trans_matches
        try { data.matches = JSON.parse(data.matches) } catch(err) {}
        data.data = lookup.custrecord_pri_cashapp_trans_data
        try { data.data = JSON.parse(data.data) } catch(err) {}
        data.setupRecord = !!lookup['custrecord_pri_cashapp_trans_batch.custrecord_pri_cashapp_batch_setup']
            && lookup['custrecord_pri_cashapp_trans_batch.custrecord_pri_cashapp_batch_setup'].length
            && lookup['custrecord_pri_cashapp_trans_batch.custrecord_pri_cashapp_batch_setup'][0].value
            || null

        return data
    }

    function queryMatchedTransactionData(ids, uniqueId = '') {
        const fn = `${scriptName}.queryMatchedTransactionData`
        let idString = ''
        for (const id of ids)
            if (!!id && id > 0)
                idString += `${id}, `
        if (idString === '') return []
        idString = idString.replace(/,\s*$/, '')
        const q = 
            `SELECT 
                t.id,
                t.recordtype,
                t.tranid,
                t.trandate,
                t.entity,
                tl.subsidiary,
                BUILTIN.DF(t.entity) as entityname,
                BUILTIN.DF(t.status) as statuslabel,
                t.status,
                t.voided,
                t.currency,
                BUILTIN.DF(t.currency) as currencyname,
                t.exchangerate,
                t.foreignTotal as total,
                t.foreignAmountUnpaid as unpaid,
                p.id as payment,
                ntll.foreignAmount as apply,
                p.custbody_pri_cashapp_transaction as cashapptransaction,
                ad.country as billcountry,
                NVL(ABS(txl.foreignAmount), 0) taxamount,
                (t.foreignTotal - NVL(ABS(txl.foreignAmount), 0)) totalnetoftax
            FROM transaction as t
            LEFT JOIN entityaddress ad ON ad.nkey = t.billingaddress
            JOIN transactionline as tl
                ON tl.transaction = t.id
                AND tl.mainline = 'T'
            LEFT JOIN transactionline as txl 
                ON txl.transaction = t.id 
                AND txl.taxtype IS NOT NULL
            LEFT JOIN NextTransactionLineLink AS ntll
                ON ntll.previousdoc = t.id
                AND ntll.linktype = 'Payment'
            LEFT JOIN transaction AS p
                ON ntll.nextdoc = p.id
                AND p.custbody_pri_cashapp_transaction IS NOT NULL
            WHERE t.id IN (${idString})`
        // log.debug(fn, {idCount:ids.length,query:q})
        try {
            const results = suiteQL.runSuiteQL({ query:q, customScriptId: uniqueId||'' }).asMappedResults()
            // log.debug(fn, {resultCount:results.length})
            return results
        } catch (err) {
            log.error(fn, {name:err.name, message:err.message})
            return []
        }
    }

    function queryPaymentsAndWriteOffs(cashAppTranId, excludeDummyPaymentId) {
        const fn = `${scriptName}.queryPaymentsAndWriteOffs: ${cashAppTranId}`
        if (!cashAppTranId) return []
        let q=`
            SELECT
                t.id,
                t.recordtype,
                BUILTIN.DF(t.id) as name,
                (CASE 
                    WHEN t.recordtype = 'customerpayment' 
                    THEN t.foreignTotal 
                    ELSE l.creditForeignAmount 
                END) as amount,
                p.previousdoc as apply_id,
                p.foreignAmount as apply_amount
            FROM transaction t
            JOIN transactionline l 
                ON l.transaction = t.id 
                AND (
                    (t.recordtype = 'customerpayment' AND l.mainline = 'F') 
                    OR (l.creditForeignAmount IS NOT NULL)
                )
            LEFT JOIN nexttransactionlinelink p ON t.id = p.nextDoc AND p.nextLine = l.id
            WHERE custbody_pri_cashapp_transaction = ${cashAppTranId}`
        if (!!excludeDummyPaymentId && !isNaN(parseInt(excludeDummyPaymentId)))
            q += ` AND t.id != ${parseInt(excludeDummyPaymentId)}`
        return runQuery(q)
    }

    function queryCashAppPayments(cashAppTranId) {
        const fn = `${scriptName}.queryCashAppPayments`

        // TODO: Add in foreign
        return runQuery(`
            SELECT 
                t.id,
                t.recordtype,
                t.tranid,
                t.trandate,
                l.subsidiary,
                l.entity,
                BUILTIN.DF(l.entity) AS entityname,
                t.status,
                BUILTIN.DF(t.status) AS statuslabel,
                t.voided,
                t.currency,
                BUILTIN.DF(t.currency) as currencyname,
                t.exchangerate,
                l.debitForeignAmount AS total,
                tl.foreignAmount AS apply,
                i.id AS invoice_id,
                i.tranid AS invoice_tranid,
                BUILTIN.DF(i.id) AS invoice_name,
                i.status AS invoice_status,
                BUILTIN.DF(i.status) AS invoice_statuslabel,
                t.foreignAmountUnpaid as unpaid,
                t.custbody_pri_cashapp_overpymtwriteoff as overpayment_writeoff,
                t.custbody_pri_cashapp_writeofftype as writeoff_type
            FROM transaction AS t
            JOIN transactionline AS l 
                ON l.transaction = t.id 
                AND l.mainline = 'T' 
                AND l.debitForeignAmount IS NOT NULL
            LEFT JOIN PreviousTransactionLineLink AS tl
                ON tl.nextdoc = t.id
                AND tl.linktype = 'Payment'
            LEFT JOIN transaction AS i
                ON i.id = tl.previousdoc
            WHERE t.custbody_pri_cashapp_transaction = ${cashAppTranId}
                AND (t.custbody_pri_cashapp_writeofftype IS NULL OR t.custbody_pri_cashapp_writeofftype = 'bankfeeunderpayment')`
        )
    }

    function queryOpenTransactionsByClientName(name = '', subsidiary = null) {
        const fn = `${scriptName}.queryOpenTransactionsByClientName`
        log.debug(fn, {name, subsidiary})
        name = name.replace(/\'/g, "")
        if (!!subsidiary) {
            subsidiary = `= ${subsidiary}`
        } else {
            subsidiary = 'IS NOT NULL'
        }
        let q =
            `SELECT
                t.id,
                t.recordtype,
                l.subsidiary,
                t.entity,
                BUILTIN.DF(t.entity) as entityname,
                t.trandate,
                t.tranid,
                t.currency,
                BUILTIN.DF(t.currency) as currencyname,
                t.exchangerate,
                t.foreignTotal as total,
                t.foreignAmountUnpaid as unpaid,
                t.status,
                BUILTIN.DF(t.status) as statuslabel,
            FROM transaction as t
            JOIN transactionline as l
                ON l.transaction = t.id
                AND l.mainline = 'T'
            JOIN customer as c
                ON c.id = t.entity
            WHERE t.recordtype = 'invoice'
                AND l.subsidiary ${subsidiary}
                AND t.billingStatus = 'T'
                AND lower(c.entitytitle) LIKE lower('%${name.toString().trim()}%')`
        const results = runQuery(q)
        log.debug(fn, {results:results.length})
        return results
    }

    /**
     * @see PRI_CashApp_MR_BatchProcessor.reduce
     * 
     * @param {number} batchId - The ID of the batch to create the transaction for
     * @param {number} sequenceNumber - The sequence number of the transaction
     * @param {Object} batchData - The batch data
     * @param {Object} transactionData - The transaction data
     * @returns {number} The ID of the created transaction
     */
    function createCashAppTransaction(batchId, sequenceNumber, batchData, transactionData) {
        const fn = `${scriptName}.createCashAppTransaction, Batch ${batchId}, #${sequenceNumber}`
        
        const rec = record.create({type:'customrecord_pri_cashapp_transaction'})
        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_batch', value:batchId})
        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_sequence_no', value:sequenceNumber})
        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_matchstatus', value:MATCH_STATUS.NOT_MATCHED})
        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_matchissues', value:MATCH_ISSUE.NO_MATCH_FOUND})
        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_data', value:JSON.stringify(transactionData)})

        if (batchData.FileType === 'BAI2') {        
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_date', value:formatDate({yymmdd:batchData.GroupHeader.asofDate})})
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_account_no', value:transactionData.AccountHeader.customerAccountNumber})
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_amount', value:parseInt(transactionData.amount)/100})
            rec.setValue({fieldId:'custrecord_pri_cashapp_trns_currencycode', value:transactionData.AccountHeader.currencyCodeAccount})
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_memo', value:transactionData.transactionTypeCode})
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_details', value:transactionData.details.join('')})
        } else if (batchData.FileType === 'BAILockbox') {
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_date', value:formatDate({yymmdd:transactionData.checkDate})})
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_check_no', value:transactionData.checkNumber})
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_account_no', value:transactionData.accountNumber})
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_amount', value:parseInt(transactionData.amount)/100})
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_cust_name', value:transactionData.customerName})
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_details', value:JSON.stringify(transactionData, null, 2)})
        } else if (batchData.FileType === 'CSV') {
            log.debug(fn, {transactionData})
            if (typeof transactionData?.transactionDate === 'string') {
                if (transactionData.transactionDate.includes('T')) {
                    transactionData.transactionDate = new Date(transactionData.transactionDate)
                } else {
                    transactionData.transactionDate = formatDate({yymmdd:transactionData.transactionDate})
                }
                log.debug(fn, {transactionDateObject:transactionData.transactionDate})
            }
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_account_no', value:transactionData.accountNumber || batchData.GroupHeader.bankId})
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_amount', value:parseInt(transactionData.amount)/100})
            if (!!transactionData.transactionDate)
                rec.setValue({fieldId:'custrecord_pri_cashapp_trans_date', value:transactionData.transactionDate})
            if (!!transactionData.checkNumber)
                rec.setValue({fieldId:'custrecord_pri_cashapp_trans_check_no', value:transactionData.checkNumber})
            if (!!transactionData.currencyCode)
                rec.setValue({fieldId:'custrecord_pri_cashapp_trns_currencycode', value:transactionData.currencyCode})
            if (!!transactionData.customerName)
                rec.setValue({fieldId:'custrecord_pri_cashapp_trans_cust_name', value:transactionData.customerName})
            if (!!transactionData.customerId)
                rec.setValue({fieldId:'custrecord_pri_cashapp_trans_cust_id', value:transactionData.customerId})
            if (!!transactionData.memo) {
                if (transactionData.memo.length > 300) 
                    transactionData.memo = `${transactionData.memo.substring(0, 297)}...`
                rec.setValue({fieldId:'custrecord_pri_cashapp_trans_memo', value:transactionData.memo})
            }
            if (!!transactionData.details)
                rec.setValue({fieldId:'custrecord_pri_cashapp_trans_details', value:JSON.stringify(transactionData.details)})
        }

        // PTM23152 - Add a serial number to the transaction record to check for duplicates
        const payloadHashString = serializeTransactionData(transactionData)
        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_serial', value:payloadHashString})

        const tranId = rec.save()
        log.audit(fn, `PRI CashApp Transaction created. ID ${tranId}`)

        // Try to load the plugin, call the plugin method, and save the returned record.
        // If the plugin fails to load/call/save, fall back to the default CashApp record. 
        let plugin = null
        let pluginData = {}
        try {
            const pl = getPlugin(batchId)
            plugin = pl.plugin
            pluginData = pl.pluginData
        } catch(e) {
            log.error(fn, `Failed to get plugin. ${e.message}. ${e.stack}`)
        }
        if (!!plugin) {
            try {
                plugin.newCashAppTransaction(tranId, transactionData, batchData, pluginData)
            } catch (err) {
                log.error(fn, `Failed to call Plugin method newCashAppTransaction. ${err.message}`)
            }
        }

        return tranId
    }

    /**
     * @see PRI_CashApp_MR_TransactionMatch.map
     * 
     * @param {number} cashAppTranId - The ID of the CashApp transaction to match
     * @param {Object} cashAppTransactionData - The CashApp transaction data
     * @param {boolean} reprocess - Whether to reprocess the transaction
     * @returns {Object} The status and matches
     */
    function matchCashAppTransaction(cashAppTranId, cashAppTransactionData, reprocess = false) {
        const fn = `${scriptName}.matchCashAppTransaction`

        const lookup = search.lookupFields({
                type:'customrecord_pri_cashapp_transaction',
                id:cashAppTranId,
                columns:[
                    'custrecord_pri_cashapp_trans_amount',
                    'custrecord_pri_cashapp_trans_cust_name',
                    'custrecord_pri_cashapp_trans_cust_id',
                    'custrecord_pri_cashapp_trans_batch.internalid',
                    'custrecord_pri_cashapp_trans_amount'
                ]
            }),
            amount = lookup.custrecord_pri_cashapp_trans_amount,
            customerName = lookup.custrecord_pri_cashapp_trans_cust_name,
            customerId = lookup.custrecord_pri_cashapp_trans_cust_id,
            batchId = lookup['custrecord_pri_cashapp_trans_batch.internalid']?.[0]?.value

        const { defaultSubsidiary } = lookupCashAppSetupByBatch(batchId)

        let rules = {}
        const ruleKeys = getCashAppMatchingRuleKeys()
        log.debug(fn, {ruleKeys})

        if (ruleKeys.includes('Customer Name='))
            rules['Customer Name='] = [customerName]
        if (ruleKeys.includes('Customer ID='))
            rules['Customer ID='] = [customerId]
      
        if (typeof cashAppTransactionData.details === 'object' && !Array.isArray(cashAppTransactionData.details)) {
            cashAppTransactionData.details = [cashAppTransactionData.details]
        }

        cashAppTransactionData.paymentAmount = parseFloat(amount)
        cashAppTransactionData.id = cashAppTranId
        cashAppTransactionData.subsidiary = defaultSubsidiary

        // Cross-reference the transaction addenda details with any matching rule keys
        for (const key of ruleKeys) {
            for (const detail of cashAppTransactionData.details) {
                // Do not process any details that are object formatted.
                if (detail instanceof Object) continue
                if (detail.indexOf(key) !== 0) continue
                if (!rules.hasOwnProperty(key)) rules[key] = []
                rules[key].push(detail.split(key)[1])
            }
        }
        log.debug(fn, {rules})
        
        // go through each cross-referenced rule key and see if there are any matching
        // open transactions for customers who have a matching rule
        let matches = {}
        if (Object.keys(rules).length) {
            for (const rule in rules) {
                const value = rules[rule],
                    matchedTransactions = queryMatchingOpenTransactionsByRule(rule, value)
                if (matchedTransactions.length) {
                    // log.debug(`${fn}: Matched transactions`, JSON.stringify(matchedTransactions))
                    matches = mapCashAppMatchingTransactions(matches, `${rule}${value}`, matchedTransactions)
                }
            }
        }

        // Try to load the plugin, call the plugin method, and save the returned record.
        // If the plugin fails to load/call/save, fall back to the default CashApp record.
        let plugin = null
        let pluginData = {}
        try {
            const pl = getPlugin(batchId)
            plugin = pl.plugin
            pluginData = pl.pluginData
        } catch(e) {
            log.error(fn, `Failed to get plugin. ${e.message}. ${e.stack}`)
        }
        let pld = {
            customerName,
            customerId,
            batchId
        }
        if (!!pluginData) {
            pld = {...pluginData, ...pld}
        }

        if (!!plugin) {
            try {
                const pluginMatched = plugin.matchCashAppTransaction(matches, cashAppTransactionData, pld)
                if (!!pluginMatched && Object.keys(pluginMatched).length) {
                    matches = pluginMatched
                    // log.debug(`${fn}: Plugin matches`, matches)
                }
            } catch (err) {
                log.error(fn, `Failed to call Plugin method matchCashAppTransaction. ${err.message}. ${err.stack}`)
            }
        }

        // If there are no matches at this point, try a fuzzy lookup by Customer Name
        if (!Object.keys(matches).length && customerName !== '') {
            const fuzzyMatch = queryOpenTransactionsByClientName(customerName, defaultSubsidiary)
            if (fuzzyMatch.length)
                matches = mapCashAppMatchingTransactions(matches, `Customer Name Like '${customerName}'`, fuzzyMatch)
        }

        // Update the PRI CashApp Transaction record with matches & status
        let status = MATCH_STATUS.NOT_MATCHED
        if (Object.keys(matches).length) {
            status = MATCH_STATUS.REVIEW
            let updateValues = {
                custrecord_pri_cashapp_trans_matchstatus: MATCH_STATUS.REVIEW,
                custrecord_pri_cashapp_trans_matches: JSON.stringify(matches)
            }

            // Set initial matching issues
            const issues = getCashAppMatchingIssues(matches, amount)
            // log.debug(`${fn} get issues`, JSON.stringify(issues))
            if (issues.length === 1)
                updateValues.custrecord_pri_cashapp_trans_matchissues = issues[0]

            try {
                record.submitFields({
                    type:'customrecord_pri_cashapp_transaction',
                    id:cashAppTranId,
                    values:updateValues
                })
            } catch (err) {
                log.error(`${fn}. ${err.name}`, JSON.stringify({values:updateValues, message:err.message}))
            }

            // Note: this is a workaround in the event of more than 1 issue code
            // NetSuite doesn't allow multi-select updates with record.submitFields :(
            if (issues.length > 1)
                updateCashAppMatchingIssues(cashAppTranId, issues)
        }

        return {status, matches}
    }

    /**
     * @see PRI_CashApp_MR_TransactionMatch.reduce
     * 
     * @param {number} cashAppTranId - The ID of the CashApp transaction to apply
     * @param {Object} matchData - The match data
     * @param {boolean} reprocess - Whether to reprocess the transaction
     */
    function autoApplyCashAppTransaction(cashAppTranId, matchData, reprocess = false) {
        const fn = `${scriptName}.autoApplyCashAppTransaction ${cashAppTranId}`
        log.debug(fn, {reprocess})
        // log.debug(fn, JSON.stringify({cashAppTranId,matchData}))

        // Lookup the Batch ID from the CashApp Transaction
        const lookup = search.lookupFields({
                type:'customrecord_pri_cashapp_transaction',
                id:cashAppTranId,
                columns:[
                    'custrecord_pri_cashapp_trans_batch.internalid',
                    'custrecord_pri_cashapp_trans_batch.custrecord_pri_cashapp_batch_setup',
                    'custrecord_pri_cashapp_trans_paymethod',
                    'custrecord_pri_cashapp_trans_dummypymt',
                    'custrecord_pri_cashapp_trans_date',
                    'custrecord_pri_cashapp_trans_amount',
                    'custrecord_pri_cashapp_trans_check_no',
                    'custrecord_pri_cashapp_trans_memo',
                    'custrecord_pri_cashapp_trans_matches'
                ]
            }),
            batchId = lookup['custrecord_pri_cashapp_trans_batch.internalid']?.[0]?.value,
            setupRecord = lookup['custrecord_pri_cashapp_trans_batch.custrecord_pri_cashapp_batch_setup']?.[0],
            paymentDate = lookup.custrecord_pri_cashapp_trans_date,
            paymentMethod = lookup.custrecord_pri_cashapp_trans_paymethod?.[0]?.value,
            dummyPayment = lookup.custrecord_pri_cashapp_trans_dummypymt?.[0]?.value,
            memo = lookup.custrecord_pri_cashapp_trans_memo,
            checkNumber = lookup.custrecord_pri_cashapp_trans_check_no,
            paymentAmount = !isNaN(parseFloat(lookup.custrecord_pri_cashapp_trans_amount))
                ? parseFloat(lookup.custrecord_pri_cashapp_trans_amount) : 0

        if (reprocess && !!dummyPayment) {
            try {
                const linkedDummyPaymentApplications = runQuery(`
                    select count(*) as count
                    from nexttransactionlink
                    where nextdoc = ${dummyPayment}
                    and linktype = 'Payment'
                `)
                if (linkedDummyPaymentApplications.length > 0 && linkedDummyPaymentApplications[0].count > 0) {
                    throw new Error(`Dummy payment ${dummyPayment} has been applied to other invoices. Cannot modify dummy payment.`)
                }
            } catch (err) {
                log.error(fn, `Failed to get linked dummy payment applications. ${err.message}`)
            }
        }

        let createdPayments = [],
            appliedTransactions = [],
            setupLookup = null,
            updateValues = {}

        // Lookup the setup record
        try {
            setupLookup = search.lookupFields({
                type:'customrecord_pri_cashapp_setup',
                id:setupRecord.value,
                columns:[
                    'custrecord_pri_cashapp_setup_dummycust',
                    'custrecord_pri_cashapp_setup_writeoffamt',
                    'custrecord_pri_cashapp_setup_wtoffdebit',
                    'custrecord_pri_cashapp_setup_wtoffcredit',
                    'custrecord_pri_cashapp_setup_wtoffrectyp',
                    'custrecord_pri_cashapp_setup_subsidiary',
                    'custrecord_pri_cashapp_setup_location',
                    'custrecord_pri_cashapp_setup_currency'
                ]
            })
        } catch (err) {}

        // Get the dummy customer ID
        const dummyCustomer = setupLookup?.custrecord_pri_cashapp_setup_dummycust?.[0]?.value || -1

        // Update initial matching issues
        const issues = getCashAppMatchingIssues(matchData, paymentAmount)

        // Attempt to apply a matching transaction with an equal amount to the payment,
        // but we need to sort by priority first
        const sorted = sortMatchedTransactions(batchId, matchData)
        log.debug(fn, JSON.stringify({sorted}))

        // Try to load the plugin, call the plugin method, and save the returned record.
        // If the plugin fails to load/call/save, fall back to the default CashApp record.
        let transactionsToApply = []
        let plugin = null
        let pluginData = {}
        try {
            const pl = getPlugin(batchId)
            plugin = pl.plugin
            pluginData = pl.pluginData
        } catch(e) {
            log.error(fn, `Failed to get plugin. ${e.message}. ${e.stack}`)
        }
        if (!!plugin) {
            try {
                transactionsToApply = plugin.autoApplyCashAppTransaction(cashAppTranId, paymentAmount, sorted, pluginData)
            } catch (err) {
                log.error(fn, `Failed to call Plugin method autoApplyCashAppTransaction. ${err.message}`)
            }
            if (transactionsToApply == null || transactionsToApply == undefined)
                transactionsToApply = []
            else if (!Array.isArray(transactionsToApply) && transactionsToApply instanceof Object)
                transactionsToApply = [transactionsToApply]
        } else {
            // If no plugin logic is defined, find the first sorted transaction with a matching amount and apply it
            for (const tran of sorted) {
                if (tran.unpaid === paymentAmount) {
                    transactionsToApply.push(tran)
                    break
                }
            }
        }
        log.debug(`${fn}: ${transactionsToApply.length} Transactions to Apply`, transactionsToApply)

        // Determine the amount of total payments already applied to the CashApp Transaction
        const totalPayments = runQuery(
            `SELECT SUM(ABS(foreignTotal)) totalapplied
            FROM transaction
            WHERE recordtype = 'customerpayment'
            AND entity <> ${dummyCustomer}
            AND custbody_pri_cashapp_transaction = ${cashAppTranId}`)?.[0]?.totalapplied || 0
        let totalApplied = totalPayments
        log.debug(fn, {totalPayments, totalApplied})
        if (transactionsToApply.length) {
            const toApplyByCustomer = {},
                sub = setupLookup?.custrecord_pri_cashapp_setup_subsidiary,
                loc = setupLookup?.custrecord_pri_cashapp_setup_location,
                currency = setupLookup?.custrecord_pri_cashapp_setup_currency?.[0]?.value || null,
                fields = {
                    date:paymentDate,
                    subsidiary:!!sub && sub.length && sub[0].value || null,
                    location:!!loc && loc.length && loc[0].value || null,
                    paymentMethod,
                    memo,
                    customer:null,
                    checkNumber,
                    amount:null
                }
            // Group transactions to apply by customer
            for (const tran of transactionsToApply) {
                const subsid = tran.subsidiary || sub?.[0]?.value || 1
                const curr = tran.currency || currency
                // Skip if the currency does not match the setup currency
                if (String(curr) !== String(currency))
                    continue
                if (!toApplyByCustomer.hasOwnProperty(tran.entity)) 
                    toApplyByCustomer[tran.entity] = {}
                if (!toApplyByCustomer[tran.entity].hasOwnProperty(subsid))
                    toApplyByCustomer[tran.entity][subsid] = { total:0, currency, matches:{} }
                toApplyByCustomer[tran.entity][subsid].total += tran.apply
                toApplyByCustomer[tran.entity][subsid].matches[tran.id] = tran
            }
            // ... and then create a customer payment for each customer
            for (const customerId in toApplyByCustomer) {
                for (const subsidiary in toApplyByCustomer[customerId]) {
                    const currency = toApplyByCustomer[customerId][subsidiary].currency
                    const total = parseFloat(toApplyByCustomer[customerId][subsidiary].total)
                    fields.amount = total
                    fields.customer = customerId

                    let paymentId = null
                    try {
                        const [pymtId] = createPayment(batchId, cashAppTranId, {...fields, subsidiary:subsidiary, currency}, 
                            toApplyByCustomer[customerId][subsidiary].matches)
                        createdPayments.push(pymtId)
                        paymentId = pymtId
                        totalApplied += total
                    } catch (err) {
                        log.error(fn, `Failed to create payment. ${err.message}`)
                        continue
                    }
                    for (const tran in toApplyByCustomer[customerId][subsidiary].matches) {
                        matchData[tran].payment = paymentId
                        matchData[tran].apply = total
                    }
                }
            }
            // ... and then set the updateValues
            updateValues.custrecord_pri_cashapp_trans_matches = JSON.stringify(matchData)
            if (parseFloat(totalApplied.toFixed(2)) !== paymentAmount) {
                updateValues.custrecord_pri_cashapp_trans_matchstatus = MATCH_STATUS.APPLIED_PARTIAL
            } else {
                updateValues.custrecord_pri_cashapp_trans_matchstatus = MATCH_STATUS.APPLIED_FULL
                updateValues.custrecord_pri_cashapp_trans_matchissues = ''
            }
        }

        // Create dummy payment if necessary
        if (!createdPayments.length || parseFloat(totalApplied.toFixed(2)) !== paymentAmount) {
            if (!!dummyPayment && reprocess) {
                let delta = paymentAmount - totalApplied
                if (delta < 0) delta = 0
                setDummyPaymentAmount(dummyPayment, delta, dummyCustomer)
            }
            else if (!!setupLookup && !dummyPayment) {
                // If no payment was matched, create a payment record for a Dummy Customer
                const loc = setupLookup?.custrecord_pri_cashapp_setup_location,
                    sub = setupLookup?.custrecord_pri_cashapp_setup_subsidiary,
                    currency = setupLookup?.custrecord_pri_cashapp_setup_currency?.[0]?.value || null
                log.debug(fn, {autoApplyDummyPayment:true, subsidiary:sub, location:loc, paymentAmount})
                try {
                    const [newDummyPayment] = createPayment(batchId, cashAppTranId, {
                            isDummyPayment:true,
                            date:paymentDate, 
                            customer:dummyCustomer,
                            subsidiary:!!sub && sub.length && sub[0].value || null,
                            location:!!loc && loc.length && loc[0].value || null, 
                            amount:paymentAmount, 
                            paymentMethod, 
                            checkNumber,
                            currency,
                            memo 
                        },{})
                    if (newDummyPayment)
                        updateValues.custrecord_pri_cashapp_trans_dummypymt = newDummyPayment
                    log.audit(`${fn}: Dummy Payment Created`, JSON.stringify({cashAppTranId, dummyPayment:newDummyPayment}))
                } catch (err) {
                    log.error(fn, `Failed to create dummy payment. ${err.message}`)
                }
            }
        } else if (!!dummyPayment) {
            // Fully applied via auto-apply: a real customer payment covers the entire amount.
            // Delete the dummy payment placeholder so cash is not double-counted.
            const remaining = setDummyPaymentAmount(dummyPayment, 0, dummyCustomer)
            updateValues.custrecord_pri_cashapp_trans_dummypymt = remaining || ''
            log.audit(`${fn}: Dummy Payment cleaned up after full auto-apply`, JSON.stringify({cashAppTranId, dummyPayment, remaining}))
        }

        // If there is only one issue, push it to the record.submitFields event
        if (updateValues.custrecord_pri_cashapp_trans_matchissues !== '' && issues.length === 1)
            updateValues.custrecord_pri_cashapp_trans_matchissues = issues[0]

        if (Object.keys(updateValues).length) {
            record.submitFields({
                type:'customrecord_pri_cashapp_transaction',
                id:cashAppTranId,
                values:updateValues
            })
        }

        // Note: this is a workaround in the event of more than 1 issue code
        // NetSuite doesn't allow multi-select updates with record.submitFields
        if (issues.length > 1)
            updateCashAppMatchingIssues(cashAppTranId, issues)
    }

    /**
     * @see PRI_CashApp_UE_BatchTransaction.afterSubmit
     * 
     * @param {number} cashAppTranId - The ID of the CashApp transaction to apply
     * @param {Object} writeOffData - The write-off data
     * @param {Object} taboolaWHTData - The WHT amount from Taboola
     */
    function applyCashAppTransaction(cashAppTranId, writeOffData = {}, taboolaWHTData = {}) {
        const fn = `${scriptName}.applyCashAppTransaction: ${cashAppTranId}`

        const transactionLookup = lookupCashAppTransaction(cashAppTranId)
        const { date, memo, batchId, paymentAmount,
            paymentMethod, checkNo, location, bankFee, bankFeeWriteOff, dummyPayment, customerId,
            foreignCurrency, foreignCurrencyName, foreignRemitAmount, fxWriteOff
        } = transactionLookup

        const setupLookup = lookupCashAppSetupByBatch(batchId)
        const { dummyCustomer, defaultSubsidiary, defaultLocation, defaultCurrency, defaultCurrencyName } = setupLookup

        log.debug(fn, {cashAppTranId, batchId, transactionLookup})

        // Get new payments to be applied by customer
        let applyByCustomer = {}
        let matches = transactionLookup.matches
        let subsidiary = defaultSubsidiary
        Object.keys(matches).forEach(m => {
            const match = matches[m]
            const subId = match.subsidiary || defaultSubsidiary || 1
            subsidiary = subId
            if (!!match.payment || !match.apply || !match.entity || isNaN(parseFloat(match.apply)))
                return
            // Do Not allow foreign currency
            if (!!foreignCurrency && String(foreignCurrency) !== String(match.currency))
                return
            else if (!foreignCurrency && String(defaultCurrency) !== String(match.currency))
                return
            const id = match.entity.toString()
            if (!applyByCustomer.hasOwnProperty(id))
                applyByCustomer[id] = {}
            if (!applyByCustomer[id].hasOwnProperty(subId))
                applyByCustomer[id][subId] = {}
            if (!applyByCustomer[id][subId].hasOwnProperty(match.currency))
                // credits:{} is initialised alongside matches:{} so that both
                // credit-memo entries (from invoice_type) and write-off JEs can be
                // merged into the same object without overwriting each other.
                applyByCustomer[id][subId][match.currency] = { amount:0, matches:{}, credits:{} }

            const isCreditMemo = match.invoice_type === 'CustCred' || match.type === 'creditmemo'

            if (isCreditMemo) {
                // Credit memos are applied via the Customer Payment 'credit' sublist.
                // They reduce the invoice balance independently and must NOT increase
                // the cash payment amount, so we only store them in credits and leave
                // data.amount untouched.
                applyByCustomer[id][subId][match.currency].credits[m] = match
            } else {
                // TODO: Account for TBLA WHT Markup. This needs to be moved to plugin logic.
                if (!!taboolaWHTData?.rate && !!match?.tblaWht?.baseApplyAmount) {
                    applyByCustomer[id][subId][match.currency].amount += match.tblaWht.baseApplyAmount
                }
                // Original logic
                else {
                    applyByCustomer[id][subId][match.currency].amount += match.apply
                }
                applyByCustomer[id][subId][match.currency].matches[m] = match
            }
        })

        // Handle write-offs
        let writeOffType = null
        let hasOverpaymentWriteOff = false, hasUnderpaymentWriteOff = false, hasBankFeeWriteOff = false
        let writeOffTransaction = null
        if (!!writeOffData || (bankFee > 0 && !bankFeeWriteOff)) {
            // const {amt, typ, inv, cust} = writeOffData
            if (!writeOffData)
                writeOffData = {}

            let plugin = null
            let pluginData = {}
            try {
                const pl = getPlugin(batchId)
                plugin = pl.plugin
                pluginData = pl.pluginData
            } catch(e) {
                log.error(fn, `Failed to get plugin. ${e.message}. ${e.stack}`)
            }
            if (!!plugin) {
                try {
                    const beforeWriteOffData = plugin.beforeApplyWriteOffData(cashAppTranId, transactionLookup, setupLookup, matches, applyByCustomer, writeOffData, pluginData)
                    if (beforeWriteOffData?.writeOffData) 
                        writeOffData = beforeWriteOffData.writeOffData
                    if (beforeWriteOffData?.applyByCustomer)
                        applyByCustomer = beforeWriteOffData.applyByCustomer
                    if (beforeWriteOffData?.matches)
                        matches = beforeWriteOffData.matches
                } catch (err) {
                    log.error(fn, `Failed to call Plugin method beforeApplyWriteOffData. ${err.message}. ${err.stack}`)
                }
            }
            
            hasOverpaymentWriteOff = writeOffData?.typ === 'O'
            hasUnderpaymentWriteOff = writeOffData?.typ === 'U'
            hasBankFeeWriteOff = bankFee > 0
            if (hasBankFeeWriteOff) {
                writeOffData.amt = bankFee;
                writeOffData.cust = dummyCustomer;

                const customerKeys = Object.keys(applyByCustomer || {});
                
                if (customerKeys.length > 0) {
                    // 1. Get the first customer ID and the customer object
                    const firstCustomerId = customerKeys[0];
                    const customerObj = applyByCustomer[firstCustomerId];
                    
                    // 2. Get the first subsidiary ID and the subsidiary object
                    const firstSubsidiaryId = Object.keys(customerObj || {})[0];
                    const subsidiaryObj = customerObj?.[firstSubsidiaryId];
                    
                    // 3. Get the first currency ID
                    const firstCurrencyId = Object.keys(subsidiaryObj || {})[0];
                    
                    // 4. Safely access the 'matches' object using optional chaining (?.)
                    const applyByCustomerMatch = subsidiaryObj?.[firstCurrencyId]?.matches;
                    
                    // 5. If matches exist and have values, assign the final data
                    if (applyByCustomerMatch && Object.values(applyByCustomerMatch).length > 0) {
                        writeOffData.inv = Object.values(applyByCustomerMatch)[0].id;
                        writeOffData.cust = firstCustomerId; // Extracted directly from the keys
                    }
                }
            }
                        
            writeOffType = hasUnderpaymentWriteOff ? 'underpayment' : null
            writeOffType = hasOverpaymentWriteOff ? 'overpayment' : writeOffType
            writeOffType = hasBankFeeWriteOff ? 'bankfeeunderpayment' : writeOffType

            if (!!writeOffType) {
                log.debug(fn, `Before ${writeOffType} Write-off. CashApp Trans ${cashAppTranId}, Invoice: ${writeOffData.inv} (${writeOffData.amt})`)
                try {
                    writeOffTransaction = writeOff(batchId, cashAppTranId, writeOffData?.amt || 0, writeOffType, 
                        writeOffData?.cust||dummyCustomer, writeOffData?.inv, date, location, subsidiary, null, (foreignCurrency || defaultCurrency))
                    log.debug(fn, `Write-off (${writeOffType}) transaction created: ${writeOffTransaction}`)
                } catch (err) {
                    log.error(fn, `Did not create write-off transaction. ${err.message}. ${err.stack}`)
                }
            }
        }

        // Calculate exchange rate
        let exchangeRate = 1
        if (/*!fxWriteOff &&*/ !!foreignCurrencyName && foreignCurrencyName !== defaultCurrencyName) {
            // exchangeRate = getCurrencyExchangeRate(date, defaultCurrencyName, foreignCurrencyName, defaultCurrencyName)
            // Taboola - Use the exchange rate from the CashApp Transaction record
            exchangeRate = transactionLookup.exchangeRate
            log.debug(fn, {exchangeRate})
        }

        // Go loop through each grouped customer. 
        // Create and apply a payment for each customer (with many invoices and/or overpayment write-offs)
        let applyTotal = 0, fxJournal = fxWriteOff, fxDifference = 0
        Object.keys(applyByCustomer).forEach(customer => {
            const subData = applyByCustomer[customer]
            log.debug(fn, {subData})
            Object.keys(subData).forEach(sub => {
                const currencyData = subData[sub]
                Object.keys(currencyData).forEach(curr => {
                    const data = subData[sub][curr]
                    log.debug(fn, {sub, data})

                    // If doing an overpayment writeoff, 
                    // add the created writeoff transaction to the matches object
                    if (hasOverpaymentWriteOff && !!writeOffTransaction && writeOffData.cust == parseInt(customer) && sub == defaultSubsidiary) {
                        if (!data.credits) data.credits = {}
                        data.matches[writeOffTransaction] = { id:writeOffTransaction, apply:writeOffData.amt, type:'overpayment' }
                    } else if (hasBankFeeWriteOff && !!writeOffTransaction && writeOffData.cust == parseInt(customer) && sub == defaultSubsidiary) {
                        if (!data.credits) data.credits = {}
                        data.credits[writeOffTransaction] = { id:writeOffTransaction, apply:writeOffData.amt, type:writeOffType }
                    }

                    // convert amount & create payment
                    const amount = data.amount
                    let payment
                    try {
                        const [pymt, fxJournalId] = createPayment(batchId, cashAppTranId, { 
                            date,
                            customer,
                            location:location||defaultLocation,
                            subsidiary:sub,
                            amount,
                            paymentMethod:paymentMethod?.value,
                            checkNumber:checkNo,
                            currency: (foreignCurrency || defaultCurrency),
                            exchangeRate,
                            foreignRemitAmount: !fxJournal ? foreignRemitAmount : undefined,
                            memo,
                            taboolaWHTData
                        }, data.matches, data.credits)
                        payment = pymt
                        if (!!fxJournalId) {
                            fxJournal = fxJournalId
                            const foreignAmountCalc = Math.round(paymentAmount / exchangeRate * 100) / 100
                            fxDifference = Math.round((foreignRemitAmount - foreignAmountCalc) * 100) / 100
                            fxDifference = Math.round(fxDifference * (exchangeRate * 100)) / 100
                        }
                        log.debug(fn,`Payment ${payment} created`)
                    } catch (err) {
                        log.error(`${fn}: Failed to create payment`, `${err.name}: ${err.message}. ${err.stack}`)
                    }

                    // Apply new payment as a property of each applied invoices in the matches object
                    if (!!payment) {
                        applyTotal += Math.round(parseFloat(Number(amount).toFixed(2)) * exchangeRate * 100) / 100
                        for (const id in data.matches) {
                            if (!matches[id]) continue
                            matches[id].payment = payment
                        }
                    }
                })
            })

            // create matching rules
            createCashAppMatchingRules(batchId, cashAppTranId, customer)
        })

        // Update/offset dummy payment record
        let newDummyPayment = null
        let total = parseFloat(Number(applyTotal).toFixed(2))
        // log.debug(fn, {total})
        if (fxDifference !== 0)
            total += Math.abs(parseFloat(Number(fxDifference).toFixed(2)))
        // log.debug(fn, {total, fxDifference})

        if (hasOverpaymentWriteOff && !!dummyPayment)
            setDummyPaymentAmount(dummyPayment, 0)
        else if (total > 0 && !!dummyPayment)
            offsetDummyPayment(dummyPayment, total)
            // setDummyPaymentAmount(dummyPayment, paymentAmount - total)
        // The scenario below is only ever needed if the dummy payment is deleted and not automatically
        // resynched. This is not currently the case, so this code is commented out
        else if (total == 0 && paymentAmount > 0 && !dummyPayment) {
            try {
                const [newDummy] = createPayment(batchId, cashAppTranId, {
                    isDummyPayment:true,
                    date, 
                    customer:dummyCustomer,
                    subsidiary:defaultSubsidiary,
                    location:defaultLocation, 
                    amount:paymentAmount,
                    paymentMethod,
                    checkNumber:checkNo,
                    currency: defaultCurrency,
                    memo 
                },{})
                newDummyPayment = newDummy 
            } catch (err) {
                log.error(fn, `Failed to create dummy payment. ${err.message}`)
            }
        }
        else if (total < 0 && !!dummyPayment)
            setDummyPaymentAmount(dummyPayment, 0)

        const rec = record.load({ type:'customrecord_pri_cashapp_transaction', id:cashAppTranId })

        // Update matches to record
        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_matches',value:JSON.stringify(matches)})

        // The dummy payment id may have been mutated by syncPaymentChange (fired
        // synchronously when createPayment saved the real customer payment above).
        // Re-read it from the freshly-loaded record so the balancingAmount loop
        // below excludes the correct dummy id.
        const liveDummyPayment = rec.getValue({fieldId:'custrecord_pri_cashapp_trans_dummypymt'}) || dummyPayment || null

        // Update matching status
        const payments = queryCashAppPayments(cashAppTranId)
        // FX scenario: when foreignCurrency is set on the cashapp trans, customer payments
        // are created in foreignCurrency while paymentAmount stays in subsidiary base, so
        // each payment's apply/total must be multiplied by its exchangerate to convert
        // foreign -> base before being compared to paymentAmount.
        const isForeignCurrency = !!foreignCurrency
        let matchStatus = getCashAppMatchingStatus(matches, paymentAmount, payments, isForeignCurrency)

        // Belt-and-suspenders: if the gross payments + write-offs net out to the cashapp
        // amount, force APPLIED_FULL. Mirrors the override already present in
        // syncPaymentChange and protects against rounding / FX edge cases inside
        // getCashAppMatchingStatus.
        //
        // Two filters are critical (both mirror syncPaymentChange line 1840–1849):
        //
        // 1. DEDUP BY PAYMENT ID — queryCashAppPayments LEFT-JOINs with
        //    PreviousTransactionLineLink to attach the invoice each payment was
        //    applied to. A payment that applies to N invoices appears as N rows,
        //    all carrying the same gross `p.total`. Without dedup the loop
        //    subtracts the payment total N times, sending balancingAmount
        //    massively negative and tripping FORCED_APPLIED_FULL on what is
        //    actually a partial apply.
        //
        // 2. EXCLUDE THE DUMMY — the dummy represents the unapplied remainder
        //    by construction. Including it always nets to zero after
        //    offsetDummyPayment runs, which would force APPLIED_FULL on a
        //    partial apply that legitimately left a dummy in place.
        let balancingAmount = parseFloat(Number(paymentAmount).toFixed(2))
        const processedPaymentIds = []
        for (const p of (payments || [])) {
            if (processedPaymentIds.indexOf(p.id) > -1) continue
            processedPaymentIds.push(p.id)
            if (liveDummyPayment && String(p.id) === String(liveDummyPayment)) continue
            const rate = isForeignCurrency ? (p.exchangerate || 1) : 1
            balancingAmount -= Math.abs(parseFloat(Number(p.total || 0).toFixed(2))) * rate
        }
        balancingAmount = parseFloat(Number(balancingAmount).toFixed(2))
        if (balancingAmount < 0.01 && matchStatus !== MATCH_STATUS.APPLIED_FULL) {
            log.audit(fn, `Forcing APPLIED_FULL. balancingAmount=${balancingAmount}, prev matchStatus=${matchStatus}, isForeignCurrency=${isForeignCurrency}`)
            matchStatus = MATCH_STATUS.APPLIED_FULL
        }

        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_matchstatus',value:matchStatus})
        log.debug(fn, {matchStatus, paymentAmount, fxDifference, payments})

        // Update matching issues
        const issues = getCashAppMatchingIssues(matches, paymentAmount)
        if (issues.length && matchStatus !== MATCH_STATUS.APPLIED_FULL)
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_matchissues',value:issues})
        else
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_matchissues',value:''})
        log.debug(fn, {issues})

        if (!dummyPayment && !!newDummyPayment)
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_dummypymt',value:newDummyPayment})

        if (bankFee > 0 && !rec.getValue('custrecord_pri_cashapp_trans_bankfeetxn'))
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_bankfeetxn',value:writeOffTransaction})

        if (!!fxJournal && !rec.getValue('custrecord_pri_cashapp_trans_fxwriteoff'))
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_fxwriteoff',value:fxJournal})

        // Save
        rec.save()
    }

    /**
     * @see PRI_CashApp_UE_BatchTransaction.afterSubmit
     * 
     * @param {number} batchId - The ID of the CashApp batch to sort the matched transactions of
     * @param {Object} matchData - The match data
     * @returns {Object[]} The sorted match data
     */
    function sortMatchedTransactions(batchId, matchData) {
        const fn = `${scriptName}.sortMatchedTransactions`
        //log.debug(fn, JSON.stringify({batchId,matchData}))

        let orderedTransactions = []
        for (const id in matchData)
            orderedTransactions.push(matchData[id])

        if (orderedTransactions.length)
            orderedTransactions
                .sort((a,b) => {
                    if (a.tranid && b.tranid) {
                        if (a.tranid<b.tranid)
                            return -1
                        else if (b.tranid>a.tranid)
                            return 1
                    } else {
                        if (a.id<b.id)
                            return -1
                        else if (a.id>b.id)
                            return 1
                    }
                    return 0
                })
                .sort((a,b) => {
                    if (!b.priority)
                        return -1
                    else if (!a.priority)
                        return 1
                    else if (a.priority<b.priority)
                        return -1
                    else if (a.priority>b.priority)
                        return 1
                    return 0
                })

        let plugin = null
        let pluginData = {}
        try {
            const pl = getPlugin(batchId)
            plugin = pl.plugin
            pluginData = pl.pluginData
        } catch(e) {
            log.error(fn, `Failed to get plugin. ${e.message}. ${e.stack}`)
        }
        if (!!plugin) {
            try {
                const pluginOrdered = plugin.sortMatchedTransactions(orderedTransactions, pluginData)
                if (!!pluginOrdered && pluginOrdered.length)
                    orderedTransactions = pluginOrdered
            } catch (err) {
                log.error(fn, `Failed to call Plugin method sortMatchedTransactions. ${err.message}`)
            }
        }
        
        return orderedTransactions
    }

    /**
     * @see PRI_CashApp_UE_BatchTransaction.afterSubmit
     * 
     * @param {number} cashAppTranId - The ID of the CashApp transaction to change the customer of
     * @param {number} customerId - The ID of the customer to change the CashApp transaction to
     */
    function changeCashAppTransactionCustomer(cashAppTranId, customerId) {
        const fn = `${scriptName}.changeCashAppTransactionCustomer`

        const { batchId } = lookupCashAppTransaction(cashAppTranId)
        
        let plugin = null
        let pluginData = {}
        try {
            const pl = getPlugin(batchId)
            plugin = pl.plugin
            pluginData = pl.pluginData
        } catch(e) {
            log.error(fn, `Failed to get plugin. ${e.message}. ${e.stack}`)
        }
        if (!!plugin) {
            try {
                plugin.changeCashAppCustomer(cashAppTranId, customerId, pluginData)
            } catch (err) {
                log.error(fn, `Failed to call Plugin method changeCashAppCustomer. ${err.message}. ${err.stack}`)
            }
        }
    }

    function filterTransactionsByNegatedRules(transactions, negatedRules) {
        const fn = `${scriptName}.filterTransactionsByNegatedRules`
        let mutated = [], rules = []
        if (!transactions.length) 
            return mutated

        // concatenate negated rules into key/value strings
        for (const n of negatedRules)
            rules.push(`${n.key}${n.value}`)

        // filter out any transactions whose details match a rule
        for (const t of transactions) {
            const details = Array.isArray(t.details) && t.details.join('') || t.details
            if (!details || !details.length) {
                mutated.push(t)
                continue
            }
            let skip = false
            for (const r of rules) {
                if (details.indexOf(r) > -1) {
                    skip = true
                    break
                }
            }
            if (!skip)
                mutated.push(t)
        }
        return mutated
    }

    function getCashAppMatchingIssues(matchData, paymentAmount = 0, payments) {
        let issues = []

        if (!matchData) {
            issues.push(MATCH_ISSUE.NO_MATCH_FOUND)
        }
        else if (typeof matchData === 'string') {
            try {
                matchData = JSON.parse(matchData)
            } catch (err) {
                matchData = {}
            }
        }
        
        if (!matchData instanceof Object || !Object.keys(matchData).length) {
            if (!~issues.indexOf(MATCH_ISSUE.NO_MATCH_FOUND))
                issues.push(MATCH_ISSUE.NO_MATCH_FOUND)
        } else {
            let customers = [], 
                totalMatch = false,
                multiTotalMatch = false,
                fuzzyTotalMatch = false

            // Convert an array to an object if necessary
            let matches = matchData
            if (Array.isArray(matchData)) {
                matches = {}
                for (const tran of matchData)
                    matches[tran.id] = tran
            }

            for (const id in matches) {
                const tran = matches[id]
                if (!~customers.indexOf(tran.entity))
                    customers.push(tran.entity)

                if (tran.status === 'B' && !~issues.indexOf(MATCH_ISSUE.MATCHING_PAID_TRANSACTION))
                    issues.push(MATCH_ISSUE.MATCHING_PAID_TRANSACTION)

                if (tran.status === 'A' && (tran.total === paymentAmount || tran.unpaid === paymentAmount)) {
                    const rules = tran.rules[0].toUpperCase()
                    if ((rules.includes('FUZZY') || rules.includes('CUSTOMER NAME LIKE')) && !fuzzyTotalMatch)
                        fuzzyTotalMatch = true
                    else {
                        if (!totalMatch)
                            totalMatch = true
                        else if (totalMatch)
                            multiTotalMatch = true
                    }
                }
            }

            if (customers.length>1)
                issues.push(MATCH_ISSUE.MULTIPLE_MATCHING_CUSTOMERS)

            if (!totalMatch && !~issues.indexOf(MATCH_ISSUE.MATCHING_PAID_TRANSACTION))
                issues.push(MATCH_ISSUE.NO_MATCHING_TOTAL_FOUND)

            if (multiTotalMatch) {
                issues.push(MATCH_ISSUE.MULTIPLE_MATCHING_TOTALS_FOUND)
            } else if (totalMatch) {
                issues.push(MATCH_ISSUE.MATCHING_TOTAL_FOUND)
            }

            if (fuzzyTotalMatch)
                issues.push(MATCH_ISSUE.MATCHING_PAID_FUZZY_TRANSACTION)
        }

        return issues
    }

    function updateCashAppMatchingIssues(cashAppTranId, issues) {
        const fn = `${scriptName}.updateCashAppMatchingIssues ${cashAppTranId}`
        try {
            const rec = record.load({ type:'customrecord_pri_cashapp_transaction', id:cashAppTranId })
            rec.setValue({fieldId:'custrecord_pri_cashapp_trans_matchissues',value:issues})
            rec.save()
        } catch (err) {
            log.error(`${fn}. ${err.name}`, {message:err.message})
        }
    }

    /**
     * Computes the matching status for a Cash-App Transaction by subtracting all applied
     * payments / write-offs from paymentAmount.
     *
     * The cashapp record's `paymentAmount` is always recorded in the subsidiary's default
     * base currency. Customer payments are created either in that same base currency (no FX)
     * or in `foreignCurrency` (FX scenarios). The behaviour of the exchange-rate handling
     * therefore depends on which scenario the caller is in:
     *
     *   - applyExchangeRate = false (default):
     *       The cashapp paymentAmount and each payment's `apply` are in the SAME currency,
     *       so we subtract directly. Multiplying by exchangerate here would convert
     *       transaction-currency into base-consolidation-currency (e.g. USD->GBP for a UK
     *       subsidiary whose base is GBP but the payment is in USD), corrupting the result.
     *
     *   - applyExchangeRate = true:
     *       The cashapp foreignCurrency is set, meaning customer payments are created in a
     *       different currency than paymentAmount (which stays in subsidiary base). We must
     *       multiply each payment's `apply` / `total` by its `exchangerate` to convert
     *       foreign -> base before subtracting.
     *
     * See the 2026-04-23 NOTE in syncPaymentChange for context.
     */
    function getCashAppMatchingStatus(matches, paymentAmount = 0, payments, applyExchangeRate = false) {
        const fn = `${scriptName}.getCashAppMatchingStatus`
        if (!matches || !Object.keys(matches).length)
            return MATCH_STATUS.NOT_MATCHED

        let status = MATCH_STATUS.REVIEW,
            amountRemaining = paymentAmount
        log.debug(fn, {paymentAmount, applyExchangeRate})
        for (const p of (payments || [])) {
            const rate = applyExchangeRate ? (p.exchangerate || 1) : 1
            if (p.overpayment_writeoff == 'T' || !!p.writeoff_type) {
                amountRemaining -= parseFloat(Number(p.total).toFixed(2)) * rate
                log.debug(fn, {amountRemaining, writeoff_type:p.writeoff_type, rate})
                continue
            }
            if (!p.apply) continue
            amountRemaining -= parseFloat(Number(p.apply).toFixed(2)) * rate
            log.debug(fn, {amountRemaining, apply:p.apply, rate})
        }

        if (paymentAmount == amountRemaining)
            status = MATCH_STATUS.REVIEW
        else if (amountRemaining > 0.01) {
            log.debug(fn, {amountRemaining, payments})
            status = MATCH_STATUS.APPLIED_PARTIAL
        }
        else 
            status = MATCH_STATUS.APPLIED_FULL
        log.debug(fn, {status, amountRemaining, paymentAmount})
        return status
    }

    function mapCashAppMatchingTransactions(matches, ruleName, matchedTransactions) {
        for (const t of matchedTransactions) {
            if (!matches.hasOwnProperty(t.id.toString())) {
                matches[t.id.toString()] = {
                    id:t.id,
                    type:t.recordtype,
                    tranid:t.tranid,
                    trandate:t.trandate,
                    entity:t.entity,
                    status:t.status,
                    subsidiary:t.subsidiary,
                    currency:t.currency,
                    fxrate:t.exchangerate,
                    total:(parseFloat(t.total)*100)/100,
                    unpaid:(parseFloat(t.unpaid)*100)/100,
                    priority:t.priority||999,
                    rules:[],
                }
            }
            if (matches[t.id].priority > t.priority)
                matches[t.id].priority = t.priority
            if (matches[t.id].rules.indexOf(ruleName) === -1)
                matches[t.id].rules.push(ruleName)
        }
        return matches
    }

    /** 
     * @see PRI_CashApp_MR_BatchProcessor.summarize
     * @see PRI_CashApp_MR_BackupProcessor.summarize
     * 
     * @param {string} deploymentId - The ID of the deployment to trigger
     * @param {Object} taskParams - The parameters to pass to the task.
     * @param {number} taskParams.batchId - The ID of the batch to trigger the matcher for.
     * @param {boolean} taskParams.reprocess - Whether to reprocess the transaction.
     */
    function triggerTransactionMatcher(deploymentId = 'customdeploy_pri_cashapp_matchprocess_mr', taskParams = {}) {
        const fn = `${scriptName}.triggerTransactionMatcher`
        const taskId = task.create({
            taskType:task.TaskType.MAP_REDUCE,
            scriptId:'customscript_pri_cashapp_matchprocess_mr',
            deploymentId,
            params:taskParams
        }).submit()
        log.debug(fn, `Script Scheduled: customscript_pri_cashapp_matchprocess_mr. Task ID: ${taskId}`)
        log.debug(fn, {taskParams})
    }

    function serializeTransactionData(transactionData) {
        const fn = `${scriptName}.serializeTransactionData`
        let payloadHash = crypto.createHash({algorithm:crypto.HashAlg.SHA256})
        payloadHash.update({input:JSON.stringify(transactionData)})
        const payloadHashString = payloadHash.digest({outputEncoding:encode.Encoding.HEX})
        return payloadHashString
    }
    
    //#endregion Transaction Methods
    /* ====================================================================================================== */
    //#region Customer Payment Methods

    function syncPaymentChange(paymentId, cashAppTranId, event, context, isVoidEvent) {
        const fn = `${scriptName}.syncPaymentChange`
        log.debug(fn, JSON.stringify({paymentId, cashAppTranId, event, context, isVoidEvent}))

        // Get a fresh set of match data
        const {
            batchId,
            date,
            memo,
            paymentMethod,
            setupRecord,
            matches,
            dummyPayment,
            paymentAmount,
            checkNo,
            location,
            foreignCurrency
        } = lookupCashAppTransaction(cashAppTranId)
        const isForeignCurrency = !!foreignCurrency

        // 1. Grab all Payments & Write-Off transactions in NS associated to the CashApp Transaction
        const paymentApplications = queryCashAppPayments(cashAppTranId)
        log.debug(`${fn}: All Payments & Applications`, JSON.stringify(paymentApplications))

        // 2. Get all match data in its current state and ensure that all payments in the match data still exist
        for (const id in matches) {
            const match = matches[id],
                payments = paymentApplications.filter(t => !!t.invoice_id && !!id && t.invoice_id.toString() === id.toString())
            
            // 3. If a payment has become unapplied, the payment should be disassocated from the Match JSON 
            if (!payments || !payments.length) {
                match.apply = null
                match.payment = null
                continue
            }
            // 4. If a payment has been voided/deleted, it should also be disassocated from the Match JSON
            else {
                for (const p of payments) {
                    if (p.recordtype === 'customerpayment') continue
                    match.unpaid = p.unpaid

                    if ((event === 'delete' || isVoidEvent) && match.payment == p.id) {
                        match.apply = null
                        match.payment = null
                    } else {
                        match.apply = p.apply
                        match.payment = p.id
                    }
                }
            }
        }
        
        // 5. Create a running balance that needs to net to $0.
        // When the cashapp trans carries a foreignCurrency, customer payments are recorded
        // in that foreign currency while paymentAmount stays in subsidiary base, so each
        // payment's total has to be multiplied by its exchangerate to convert back to
        // paymentAmount's currency. When there is no foreignCurrency, both sides are already
        // in the same currency (see 2026-04-23 NOTE; the exchangerate field on a payment
        // record in that case represents a subsidiary-level consolidation rate and must NOT
        // be applied here, otherwise we'd incorrectly leave amountRemaining > 0).
        let balancingAmount = paymentAmount,
            processedPaymentIds = []
        for (const p of paymentApplications) {
            if (processedPaymentIds.indexOf(p.id) > -1) continue
            processedPaymentIds.push(p.id)
            // If the current payment is being deleted, do not count it toward the totals
            if ((event === 'delete' || isVoidEvent) && p.id.toString() === paymentId.toString()) continue
            // Filter out dummy payments from the total calculations
            if (p.id == dummyPayment) continue
            const rate = isForeignCurrency ? (p.exchangerate || 1) : 1
            balancingAmount -= Math.abs(p.total) * rate
        }
        balancingAmount = parseFloat(balancingAmount.toFixed(2))
        log.debug(fn, `Updated Balancing Amount: ${balancingAmount} (isForeignCurrency=${isForeignCurrency})`)

        // 6. At the end, any remaining balance should transfer back to the Dummy Payment
        // 7. If there is no remaining balance, the existing dummy payment should be deleted (if any)
        // Create or offset dummy payment
        let updatedDummyPayment = dummyPayment
        // Taboola - If the remaining balance is greater than or equal to $0.1, create a new dummy payment
        const taboolaFxBalanceThreshold = 0.1
        if (parseFloat(balancingAmount.toFixed(2)) >= taboolaFxBalanceThreshold) {
            if (!dummyPayment || (dummyPayment.toString() === paymentId.toString() && (event === 'delete' || isVoidEvent))) {
                log.debug(`${fn}: Create new Dummy Payment`, `Payment Method = ${paymentMethod}`)
                const lookup = lookupCashAppSetupByBatch(batchId)
                log.debug(fn, {type: typeof lookup, lookup:lookup})
                const [updatedPymt] = createPayment(batchId, cashAppTranId, {
                    isDummyPayment:true,
                    date, 
                    customer:lookup.dummyCustomer, 
                    subsidiary:lookup.defaultSubsidiary,
                    location:location||lookup.defaultLocation,
                    amount:balancingAmount, 
                    paymentMethod:paymentMethod?.value, 
                    checkNumber:checkNo,
                    currency:lookup.defaultCurrency,
                    memo
                }, {})
                updatedDummyPayment = updatedPymt
            } else {
                // Offset dummy payment
                // updatedDummyPayment = setDummyPaymentAmount(dummyPayment, balancingAmount)
                updatedDummyPayment = offsetDummyPayment(dummyPayment, balancingAmount)
            }
        } else if (!!dummyPayment) {
            updatedDummyPayment = setDummyPaymentAmount(dummyPayment, 0)
        }

        // 8. Last Step, Update the CashApp Transaction record with any changes to state
        const issues = getCashAppMatchingIssues(matches, paymentAmount)
        let matchStatus = getCashAppMatchingStatus(matches, paymentAmount, paymentApplications, isForeignCurrency)
        if (balancingAmount < 0.01)
            matchStatus = MATCH_STATUS.APPLIED_FULL

        const rec = record.load({ id:cashAppTranId, type:'customrecord_pri_cashapp_transaction' })
        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_matches',value:JSON.stringify(matches)})
        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_matchstatus',value:matchStatus})
        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_matchissues',value:matchStatus !== MATCH_STATUS.APPLIED_FULL && issues.length && issues || ''})
        rec.setValue({fieldId:'custrecord_pri_cashapp_trans_dummypymt',value:updatedDummyPayment||''})
        rec.save()
    }

    function moveBalanceToCustomer(cashAppTranId, consolidate = true) {
        const fn = `${scriptName}.moveBalanceToCustomer: ${cashAppTranId}`
        
        const {
            batchId,
            date,
            dummyPayment,
            customerRecordId,
            paymentMethod,
            paymentAmount,
            currency,
            // Taboola Cash App Transaction - Editable Exchange Rate
            exchangeRate,
            foreignRemitAmount,
            foreignCurrency,
            foreignCurrencyName,
            checkNo,
            memo,
            location
        } = lookupCashAppTransaction(cashAppTranId)
        const { total: dummyTotal } = lookupPayment(dummyPayment)
        const total = dummyTotal || paymentAmount

        const { defaultSubsidiary, defaultLocation, defaultCurrency, paymentMethod:defaultPaymentMethod } = lookupCashAppSetupByBatch(batchId)

        let paymentId = null

        // FX-safety: the dummy payment is always created in defaultCurrency
        // (see syncPaymentChange's createPayment call passing currency:lookup.defaultCurrency),
        // so `total` (= dummyTotal) is a defaultCurrency amount. The move-balance
        // target payment must therefore also live in defaultCurrency, otherwise we'd
        // be writing a base-currency value into a foreign-currency payment's
        // `payment` field.
        //
        // In an FX scenario (cashapp trans has foreignCurrency set) the most recent
        // customerpayment for the real customer is typically the foreignCurrency
        // payment that was created to apply against the foreign invoice. Without the
        // currency filter below, the consolidate query would pick that payment up
        // and incrementPaymentAmount would graft a defaultCurrency amount onto a
        // foreignCurrency balance — and then the dummy gets deleted, leaving the
        // leftover orphaned on the FX payment.
        if (consolidate) {
            log.debug(fn, `Attempting to consolidate payment for customer ${customerRecordId} and cash app transaction ${cashAppTranId}..`)
            const existingPayment = runQuery(
                `SELECT TOP 1 id FROM transaction 
                WHERE recordtype = 'customerpayment' AND entity = ${customerRecordId} AND custbody_pri_cashapp_transaction = ${cashAppTranId} 
                AND currency = ${defaultCurrency}
                ORDER BY id DESC`
            )
            if (existingPayment.length) {
                log.debug(fn, `Existing payment found for customer ${customerRecordId} and cash app transaction ${cashAppTranId}. Incrementing payment amount by ${total}.`)
                paymentId = existingPayment[0].id
                incrementPaymentAmount(paymentId, total)
            }
        }
        

        if (!paymentId) {
            let arAccount = runQuery(`SELECT receivablesaccount FROM customer WHERE id = ${customerRecordId}`)?.[0]?.receivablesaccount;
            if (isNaN(parseInt(arAccount)) || parseInt(arAccount) === -10) {
                arAccount = undefined
            }
            // Move the balance to a new Payment for the specified customer/location.
            // Intentionally do NOT pass foreignCurrency / exchangeRate / foreignRemitAmount
            // here: this payment carries the dummy's leftover base-currency balance,
            // not a foreign-invoice application. Forwarding the FX fields would make
            // createPayment build the new payment in foreignCurrency with
            // `payment = foreignRemitAmount` (the original full FX amount of the
            // cashapp tran), which is both the wrong currency and the wrong amount.
            const [newPymtId] = createPayment(batchId, cashAppTranId, {
                date, 
                customer:customerRecordId, 
                subsidiary:defaultSubsidiary,
                location:location||defaultLocation,
                currency:defaultCurrency,
                arAccount:arAccount ?? undefined,
                amount:total, 
                paymentMethod:paymentMethod?.value || defaultPaymentMethod, 
                checkNumber:checkNo,
                memo
            }, {})
            paymentId = newPymtId
            log.debug(fn, `Customer payment ${paymentId} created.`)
        }

        // Prepayment memo override — use custrecord_tb_cashapp_prepay_memo from setup
        if (paymentId) {
            try {
                const pl = getPlugin(batchId)
                if (pl.plugin && pl.plugin.resolvePaymentMemos) {
                    const resolved = pl.plugin.resolvePaymentMemos(null, cashAppTranId, {}, {setup: lookupCashAppSetupByBatch(batchId), ...pl.pluginData})
                    if (resolved.prepayMemo) {
                        record.submitFields({ type: 'customerpayment', id: paymentId, values: { memo: truncMemo(resolved.prepayMemo) } })
                        log.debug(fn, `[MEMO TRACE] Updated payment ${paymentId} memo with prepayMemo: "${resolved.prepayMemo}"`)
                    }
                }
            } catch (memoErr) {
                log.debug(fn, `Prepayment memo resolution skipped: ${memoErr.message}`)
            }
        }

        // Delete the dummy payment
        if (!!dummyPayment)
            setDummyPaymentAmount(dummyPayment, 0)

        // Taboola - Update the CashApp Transaction status to Manually Moved
        record.submitFields({
            id:cashAppTranId,
            type:'customrecord_pri_cashapp_transaction',
            values:{
                custrecord_pri_cashapp_trans_matchstatus:MATCH_STATUS.MANUAL,
                custrecord_pri_cashapp_trans_matchissues:''
            }
        })

        return paymentId
    }

    // Taboola Cash App Transaction - Move Balance to Customer Deposit
    function moveBalanceToCustomerDeposit(cashAppTranId) {
        const fn = `${scriptName}.moveBalanceToCustomerDeposit: ${cashAppTranId}`
        
        const {
            batchId,
            date,
            dummyPayment,
            customerRecordId,
            paymentMethod,
            paymentAmount,
            currency,
            exchangeRate,
            foreignRemitAmount,
            foreignCurrency,
            foreignCurrencyName,
            checkNo,
            memo,
            location
        } = lookupCashAppTransaction(cashAppTranId)
        const { total: dummyTotal } = lookupPayment(dummyPayment)
        const total = dummyTotal || paymentAmount
        const { defaultSubsidiary, defaultLocation, defaultCurrency, 
            paymentMethod:defaultPaymentMethod, dummyCustomer, cashAccount, undepositedFunds
        } = lookupCashAppSetupByBatch(batchId)

        let depositId = null

        const rec = record.create({type:'customerdeposit', isDynamic:true})
        rec.setValue('customer', customerRecordId || dummyCustomer)
        rec.setValue('subsidiary', defaultSubsidiary)
        rec.setValue('trandate', formatDate(date))
        rec.setValue('memo', truncMemo(memo))
        rec.setValue('custbody_pri_cashapp_transaction', cashAppTranId)
        rec.setValue('custbody_pri_cashapp_batch', batchId)
        if (!!location)
            rec.setValue('location', location)
        else if (!!defaultLocation)
            rec.setValue('location', defaultLocation)

        if (!foreignCurrency) {
            rec.setValue('currency', defaultCurrency)
            rec.setValue('payment', total)
        } else {
            rec.setValue('currency', foreignCurrency)
            rec.setValue('exchangerate', exchangeRate)
            rec.setValue('payment', foreignRemitAmount || total)
        }

        if (!!paymentMethod) {
            rec.setValue('paymentmethod', paymentMethod?.value || paymentMethod)
        } else if (!!defaultPaymentMethod) {
            rec.setValue('paymentmethod', defaultPaymentMethod)
        }
        if (!undepositedFunds && !!cashAccount) {
            rec.setValue({fieldId:'undepfunds',value:'F'})
            rec.setValue({fieldId:'account',value:cashAccount})
        } else {
            rec.setValue({fieldId:'undepfunds',value:'T'})
        }
        if (!!checkNo && checkNo !== '')
            rec.setValue({fieldId:'checknum',value:checkNo})

        // Dynamic memo resolution via plugin — prepayment transactions use custrecord_tb_cashapp_prepay_memo
        try {
            const pl = getPlugin(batchId)
            if (pl.plugin && pl.plugin.resolvePaymentMemos) {
                const resolved = pl.plugin.resolvePaymentMemos(rec, cashAppTranId, {}, {setup: lookupCashAppSetupByBatch(batchId), ...pl.pluginData})
                if (resolved.prepayMemo)
                    rec.setValue('memo', resolved.prepayMemo)
                else if (resolved.customMemo)
                    rec.setValue('memo', resolved.customMemo)
                else if (resolved.memo)
                    rec.setValue('memo', resolved.memo)
                log.debug(fn, { resolvedMemos: resolved })
            }
        } catch (memoErr) {
            log.debug(fn, `Plugin memo resolution skipped: ${memoErr.message}`)
        }

        depositId = rec.save()
        log.debug(fn, `Customer deposit ${depositId} created.`)

        // Delete the dummy payment
        if (!!dummyPayment)
            setDummyPaymentAmount(dummyPayment, 0)

        // Update the CashApp Transaction status to Manually Moved
        record.submitFields({
            id:cashAppTranId,
            type:'customrecord_pri_cashapp_transaction',
            values:{
                custrecord_pri_cashapp_trans_matchstatus:MATCH_STATUS.MANUAL,
                custrecord_pri_cashapp_trans_matchissues:''
            }
        })

        return depositId
    }

    /**
     * Creates a Cash Sale (prepayment) for the transaction's assigned customer.
     * Used for India prepayment flows: builds 3 item lines that net to the
     * gross amount while correctly splitting base and GST components.
     *
     * Setup fields consumed from customrecord_pri_cashapp_setup:
     *   custrecord_tb_india_prepay_item      — Service item for prepayment lines (1 & 3)
     *   custrecord_tb_india_tax_prepay_item  — Service item for the tax-reversal line (2)
     *   custrecord_tb_india_zero_taxcode     — 0% tax code used on lines 2 & 3
     *
     * @param {number|string} cashAppTranId
     * @returns {number} cashSaleId
     */
    function cashSalePrepayment(cashAppTranId) {
        const fn = `${scriptName}.cashSalePrepayment: ${cashAppTranId}`

        const {
            batchId, date, dummyPayment, customerRecordId, paymentAmount,
            memo, location, currency, foreignCurrency, exchangeRate,
            foreignRemitAmount
        } = lookupCashAppTransaction(cashAppTranId)
        const { total: dummyTotal } = lookupPayment(dummyPayment)
        const total = dummyTotal || paymentAmount
        const setup = lookupCashAppSetupByBatch(batchId)
        const { defaultSubsidiary, defaultLocation, defaultCurrency, cashAccount } = setup

        // Resolve the setup record ID from the batch to look up India-specific fields
        const batchSetupLookup = search.lookupFields({
            type: 'customrecord_pri_cashapp_batch',
            id: batchId,
            columns: ['custrecord_pri_cashapp_batch_setup']
        })
        const setupId = batchSetupLookup?.custrecord_pri_cashapp_batch_setup?.[0]?.value
        if (!setupId) throw new Error(`No setup record found for batch ${batchId}`)

        const indiaSetup = search.lookupFields({
            type: 'customrecord_pri_cashapp_setup',
            id: setupId,
            columns: [
                'custrecord_tb_india_prepay_item',
                'custrecord_tb_india_tax_prepay_item',
                'custrecord_tb_india_zero_taxcode'
            ]
        })
        const prepayItem = indiaSetup?.custrecord_tb_india_prepay_item?.[0]?.value
        const taxPrepayItem = indiaSetup?.custrecord_tb_india_tax_prepay_item?.[0]?.value
        const zeroTaxCode = indiaSetup?.custrecord_tb_india_zero_taxcode?.[0]?.value

        if (!prepayItem || !taxPrepayItem)
            throw new Error(`India prepayment items not configured on setup ${setupId}`)

        // Look up the customer's tax item and its rate
        const custLookup = search.lookupFields({
            type: 'customer',
            id: customerRecordId,
            columns: ['taxitem']
        })
        const taxItemId = custLookup?.taxitem?.[0]?.value
        if (!taxItemId) throw new Error(`No taxitem configured on customer ${customerRecordId}`)

        const taxRows = runQuery(`SELECT rate FROM taxItemTaxGroup WHERE id = ${parseInt(taxItemId)}`)
        const taxRate = taxRows?.length ? parseFloat(taxRows[0].rate) : 0
        if (!taxRate || taxRate <= 0)
            throw new Error(`Cannot determine tax rate for taxitem ${taxItemId} (got ${taxRate})`)

        // Calculate amounts: grossAmount equals the CashApp transaction amount (includes tax).
        // taxRate is a decimal from taxItemTaxGroup (e.g. 0.18 for 18%).
        // Line 1 rate = grossAmount / (1 + taxRate), tax is auto-calculated by NetSuite.
        // Lines 2 & 3 amount = grossAmount - line1Rate  (the tax portion).
        const grossAmount = Math.abs(total)
        const baseAmount = Math.round(grossAmount / (1 + taxRate) * 100) / 100
        const taxAmount = Math.round((grossAmount - baseAmount) * 100) / 100

        log.debug(fn, { grossAmount, taxRate, baseAmount, taxAmount, prepayItem, taxPrepayItem, taxItemId, zeroTaxCode })

        // Create Cash Sale
        const rec = record.create({ type: 'cashsale', isDynamic: true })
        rec.setValue({ fieldId: 'customform', value: 236 })
        rec.setValue({ fieldId: 'entity', value: customerRecordId })
        if (defaultSubsidiary)
            rec.setValue({ fieldId: 'subsidiary', value: defaultSubsidiary })
        rec.setValue({ fieldId: 'trandate', value: formatDate(date) })
        rec.setValue({ fieldId: 'custbody_item_schedule_gst', value: '4' })
        rec.setValue({ fieldId: 'custbody_pri_cashapp_transaction', value: cashAppTranId })
        rec.setValue({ fieldId: 'custbody_pri_cashapp_batch', value: batchId })

        if (foreignCurrency) {
            rec.setValue({ fieldId: 'currency', value: foreignCurrency })
            if (exchangeRate && exchangeRate !== 1)
                rec.setValue({ fieldId: 'exchangerate', value: exchangeRate })
        } else if (defaultCurrency) {
            rec.setValue({ fieldId: 'currency', value: defaultCurrency })
        }

        if (cashAccount)
            rec.setValue({ fieldId: 'account', value: cashAccount })
        if (location)
            rec.setValue({ fieldId: 'location', value: location })
        else if (defaultLocation)
            rec.setValue({ fieldId: 'location', value: defaultLocation })
        if (memo)
            rec.setValue({ fieldId: 'memo', value: truncMemo(memo) })

        // Dynamic memo resolution via plugin — prepayment transactions use custrecord_tb_cashapp_prepay_memo
        try {
            const pl = getPlugin(batchId)
            if (pl.plugin && pl.plugin.resolvePaymentMemos) {
                const resolved = pl.plugin.resolvePaymentMemos(rec, cashAppTranId, {}, { setup, ...pl.pluginData })
                if (resolved.prepayMemo)
                    rec.setValue({ fieldId: 'memo', value: resolved.prepayMemo })
                else if (resolved.customMemo)
                    rec.setValue({ fieldId: 'memo', value: resolved.customMemo })
                else if (resolved.memo)
                    rec.setValue({ fieldId: 'memo', value: resolved.memo })
            }
        } catch (memoErr) {
            log.debug(fn, `Plugin memo resolution skipped: ${memoErr.message}`)
        }

        // ── Line 1: Prepayment item at base amount with customer tax code ──
        rec.selectNewLine({ sublistId: 'item' })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: prepayItem })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: baseAmount })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: baseAmount })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'taxcode', value: taxItemId })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_igst_amount', value: taxAmount })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_igst_rate', value: taxRate })
        rec.commitLine({ sublistId: 'item' })

        // ── Line 2: Tax prepayment item at negative tax amount (0% tax) ──
        rec.selectNewLine({ sublistId: 'item' })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: taxPrepayItem })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: -taxAmount })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: -taxAmount })
        if (zeroTaxCode)
            rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'taxcode', value: zeroTaxCode })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_igst_amount', value: 0 })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_igst_rate', value: 0 })
        rec.commitLine({ sublistId: 'item' })

        // ── Line 3: Prepayment item at tax amount (0% tax) ──
        rec.selectNewLine({ sublistId: 'item' })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'item', value: prepayItem })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'quantity', value: 1 })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'rate', value: taxAmount })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'amount', value: taxAmount })
        if (zeroTaxCode)
            rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'taxcode', value: zeroTaxCode })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_igst_amount', value: 0 })
        rec.setCurrentSublistValue({ sublistId: 'item', fieldId: 'custcol_igst_rate', value: 0 })
        rec.commitLine({ sublistId: 'item' })

        const cashSaleId = rec.save({ ignoreMandatoryFields: true })
        log.audit(fn, `Cash Sale (prepayment) ${cashSaleId} created. gross=${grossAmount}, base=${baseAmount}, tax=${taxAmount}`)

        // Delete the dummy payment
        if (dummyPayment)
            setDummyPaymentAmount(dummyPayment, 0)

        // Update the CashApp Transaction status
        record.submitFields({
            id: cashAppTranId,
            type: 'customrecord_pri_cashapp_transaction',
            values: {
                custrecord_pri_cashapp_trans_matchstatus: MATCH_STATUS.MANUAL,
                custrecord_pri_cashapp_trans_matchissues: ''
            }
        })

        return cashSaleId
    }

    function lookupPayment(paymentId) {
        if (!paymentId) return { customer: null, location: null, total: 0 }

        const lookup = search.lookupFields({
            type:'customerpayment',
            id:paymentId,
            columns:[
                'entity',
                'location',
                'total',
                'fxamount'
            ]
        })

        const data = {}
        if (!lookup) return data

        data.customer = !!lookup.entity && lookup.entity.length && lookup.entity[0].value || null
        data.location = !!lookup.location && lookup.location.length && lookup.location[0].value || null
        data.total = !isNaN(parseFloat(lookup.total)) && parseFloat(lookup.total) || 0
        if (!isNaN(parseFloat(lookup.fxamount)) && parseFloat(lookup.fxamount) !== data.total) {
            data.total = parseFloat(Number(lookup.fxamount).toFixed(2))
        }

        return data
    }

    function createPayment(batchId, cashAppTranId, fields, matches, credits = {}, didRetry = false) {
        const fn = `${scriptName}.createPayment for ${cashAppTranId}`,
            type = 'customerpayment',
            { date, subsidiary, customer, location, amount = 0, paymentMethod, memo, checkNumber = '', 
                currency = null, exchangeRate = 1, foreignRemitAmount = null,
                // Taboola Cash App Transaction - Editable Exchange Rate
                foreignCurrency,
            } = fields

        const setup = lookupCashAppSetupByBatch(batchId)
        const { defaultCurrency } = setup
        const { paymentAmount } = lookupCashAppTransaction(cashAppTranId)
        fields.paymentAmount = paymentAmount

        log.debug(fn, {batchId, cashAppTranId, matches, credits, fields})
        if (amount == 0 && !!credits && !Object.keys(credits).length) {
            log.audit(`${fn}: Not creating $0 payment`)
            return [null]
        }
        if (!customer) {
            log.audit(`${fn}: Not creating payment with no customer`, customer)
            return [null]
        }

        // Create Payment
        // Taboola - FX Journal is not needed for their currency conversions
        let fxJournalId = null, fxDifference = 0
        // if (!!exchangeRate && exchangeRate !== 1 && !!foreignRemitAmount) {
        //     const foreignAmountCalc = Math.round(paymentAmount / exchangeRate * 100) / 100
        //     fxDifference = Math.round((foreignRemitAmount - foreignAmountCalc) * 100) / 100
        //     log.debug(fn, {exchangeRate, amount, foreignRemitAmount, fxDifference})
        //     try {
        //         fxJournalId = createWriteOffJE(batchId, cashAppTranId, date, (subsidiary || setup.defaultSubsidiary), customer, 
        //             fxDifference, setup.fxDebitAccount, setup.arAccount, 
        //             `Cash App FX Journal for Cash App Transaction ${cashAppTranId}`, (location||setup.defaultLocation), 'fxwriteoff', currency)
        //         log.debug(fn, `FX Journal ${fxJournalId} created.`)
        //         if (fxDifference < 0) {
        //             matches[fxJournalId] = { id:fxJournalId, apply:fxDifference, type:'fxwriteoff' }
        //         } else {
        //             credits[fxJournalId] = { id:fxJournalId, apply:fxDifference, type:'fxwriteoff' }
        //         }
        //     } catch (err) {
        //         log.error(fn, `Failed to create FX Journal. ${err.message}. ${err.stack}`)
        //     }
        // }
            
        // Pass customform via defaultValues so the form is locked in before any other
        // fields are set (form switches can otherwise reset fields). Falls back to
        // NetSuite's default form when defaultPaymentForm is not configured on setup.
        const createOpts = {type, isDynamic:true}
        if (setup.defaultPaymentForm)
            createOpts.defaultValues = {customform: setup.defaultPaymentForm}
        const pymt = record.create(createOpts),
            // method to apply a line on a dynamic customerpayment
            setLine = (sublistId, line, data) => {
                pymt.selectLine({ sublistId, line })
                pymt.setCurrentSublistValue({ sublistId, fieldId:'apply', value:true })
                pymt.setCurrentSublistValue({ sublistId, fieldId:'amount', value:data.apply })
                pymt.commitLine({ sublistId })
            }
        log.debug(fn, `Creating payment...`)

        log.debug(fn, `Setting customer to ${customer}`)
        pymt.setValue({fieldId:'customer',value:customer})

        // Set fields
        if (!!subsidiary)
            pymt.setValue({fieldId:'subsidiary',value:subsidiary})
        else if (!!setup.defaultSubsidiary)
            pymt.setValue({fieldId:'subsidiary',value:setup.defaultSubsidiary})

        // Taboola Cash App Transaction - Editable Exchange Rate
        if (!!foreignCurrency) {
            pymt.setValue({fieldId:'currency',value:foreignCurrency})
        } else if (!!currency)
            pymt.setValue({fieldId:'currency',value:currency})
        else if (!!defaultCurrency)
            pymt.setValue({fieldId:'currency',value:defaultCurrency})

        pymt.setValue({fieldId:'custbody_pri_cashapp_batch',value:batchId})
        pymt.setValue({fieldId:'custbody_pri_cashapp_transaction',value:cashAppTranId})

        const dt = formatDate(date)
        pymt.setValue({fieldId:'trandate',value:dt})
        pymt.setValue({fieldId:'autoapply',value:false})

        log.debug(fn, `[MEMO TRACE] Initial fields.memo = "${memo}"`)
        if (memo)
            pymt.setValue({fieldId:'memo',value:truncMemo(memo)})
        if (!!location)
            pymt.setValue({fieldId:'location',value:location})
        else if (!!setup.defaultLocation)
            pymt.setValue({fieldId:'location',value:setup.defaultLocation})

        let hasCustomerARAccount = false
        if (!fields.arAccount) {
            // Lookup AR account from the customer record
            try {
                let arAccount = runQuery(`SELECT receivablesaccount FROM customer WHERE id = ${customer}`)?.[0]?.receivablesaccount;
                log.debug(fn, {arAccount})
                if (isNaN(parseInt(arAccount)) || parseInt(arAccount) === -10) {
                    arAccount = undefined
                } else {
                    fields.arAccount = arAccount
                    hasCustomerARAccount = true
                }
            }catch (err) {
                log.debug(fn, `Failed to get AR Account. ${err.message}. ${err.stack}`)
            }
        }

        if (!!fields.arAccount) 
            pymt.setValue({fieldId:'aracct',value:fields.arAccount})
        else if (!!setup.arAccount) 
            pymt.setValue({fieldId:'aracct',value:setup.arAccount})

        if (!!paymentMethod) {
            const value = paymentMethod instanceof Object && paymentMethod?.value||paymentMethod
            pymt.setValue({fieldId:'paymentmethod', value, ignoreFieldChange:true})
            log.audit(fn, `Payment method set to value ${value}`)
        }
        else if (!!setup.paymentMethod) {
            const value = setup.paymentMethod instanceof Object && setup.paymentMethod?.value||setup.paymentMethod
            pymt.setValue({fieldId:'paymentmethod', value, ignoreFieldChange:true})
            log.audit(fn, `Payment method set to setup value ${value}`)
        }

        if (!!exchangeRate && exchangeRate !== 1) {
            pymt.setValue({fieldId:'exchangerate',value:exchangeRate})
            log.debug(fn, `Exchange rate set to ${exchangeRate}`)
        }

        if (!!checkNumber && checkNumber !== '')
            pymt.setValue({fieldId:'checknum',value:checkNumber})
        if (!setup.undepositedFunds && !!setup.cashAccount) {
            try {
                pymt.setValue({fieldId:'undepfunds',value:'F'})
                pymt.setValue({fieldId:'account',value:setup.cashAccount})
            } catch (err) {
                log.error(fn, `Failed to set Payment account. ${err.message}. ${err.stack}`)
                pymt.setValue({fieldId:'undepfunds',value:'T'})
                pymt.setValue({fieldId:'account',value:''})
            }
        } else {
            pymt.setValue({fieldId:'undepfunds',value:'T'})
        }

        // Set any lines that need to be applied
        let applyTotal = 0

        let bankFeeOffset = 0
        if (!!credits && Object.keys(credits).length > 0) {
            const sublistId = 'credit'
            for (const id in credits) {
                const line = pymt.findSublistLineWithValue({ sublistId, fieldId:'internalid', value:parseInt(id) })
                if (line === -1) {
                    log.error(`${fn}: Cannot find specified credit transaction to apply payment`,
                        JSON.stringify({id, credit:credits[id]}))
                    continue
                }
                const lnApply = credits[id].apply
                if (credits[id]?.type != 'bankfeeunderpayment') {
                    applyTotal -= lnApply
                } else {
                    bankFeeOffset += lnApply
                }
                setLine(sublistId, line, { apply:lnApply })
                log.debug(fn, `Applying ${lnApply} credit from transaction ${id} to payment...`)
            }
        }

        if (!!matches && Object.keys(matches).length > 0) {
            // Change the AR Account before try to apply the matches
            if (!hasCustomerARAccount) {
                try {
                    log.debug(fn, `Looking up AR Account for ${Object.keys(matches)[0]}`)
                    const arAcct = search.lookupFields({type:'transaction', id:parseInt(Object.keys(matches)[0]), columns:['account']})?.account?.[0]?.value
                    if (!!arAcct && !isNaN(parseInt(arAcct)) && parseInt(arAcct) !== parseInt(setup?.arAccount)) {
                        pymt.setValue({fieldId:'aracct',value:parseInt(arAcct)})
                    }
                } catch (err) {
                    log.error(fn, `Failed to change AR Account. ${err.message}. ${err.stack}`)
                }
            }
            const sublistId = 'apply'
            for (const id in matches) {
                const line = pymt.findSublistLineWithValue({ sublistId, fieldId:'internalid', value:parseInt(id) })
                if (line === -1) {
                    log.error(`${fn}: Cannot find specified matching transaction to apply payment`,
                        JSON.stringify({id, match:matches[id]}))
                    // 2024-10-18: Add retry logic for overpayment writeoffs in the event of a match not being found
                    if (matches[id]?.type == 'overpayment' && didRetry !== true) {
                        log.debug(fn, 'Failed to find matching transaction for overpayment writeoff.')
                        // return createPayment(batchId, cashAppTranId, fields, matches, credits, true)
                    }
                    continue
                }
                const due = pymt.getSublistValue({ sublistId, line, fieldId:'due' })
                if (fxDifference > 0 && due > matches[id].apply) {
                    log.debug(fn, `Adjusting match ${id} apply amount ${matches[id].apply} by ${fxDifference} due to FX difference`)
                    matches[id].apply += fxDifference
                }
                if (bankFeeOffset > 0 && due > matches[id].apply) {
                    log.debug(fn, `Adjusting match ${id} apply amount ${matches[id].apply} by ${bankFeeOffset} due to Bank Fee Underpayment`)
                    matches[id].apply += bankFeeOffset
                    bankFeeOffset = 0
                }
                if (matches[id].apply > due) {
                    log.debug(fn, `Adjusting match ${id} apply amount ${matches[id].apply} to ${due} due to overpayment`)
                    matches[id].apply = due
                }
                const lnApply = Math.abs(matches[id].apply)
                applyTotal += lnApply
                setLine(sublistId, line, { apply:lnApply })
                log.debug(fn, `Applying ${lnApply} from transaction ${id} to payment...`)
            }
        }

        // if (!!exchangeRate && exchangeRate !== 1 && !!foreignRemitAmount) { 
        //     pymt.setValue({fieldId:'payment', value:foreignRemitAmount})
        // }
        // else 
        if (applyTotal == 0 && amount > 0) {
            // Taboola Cash App Transaction - Editable Exchange Rate
            if (!foreignCurrency) {
                pymt.setValue({fieldId:'payment', value:amount})
            } else {
                pymt.setValue({fieldId:'payment', value:foreignRemitAmount || amount})
            }
        }

        if (Object.keys(setup.pluginData?.paymentDefaults??{}).length) {
            for (const [key, value] of Object.entries(setup.pluginData.paymentDefaults)) {
                if (!!value)
                    pymt.setValue({fieldId:key, value})
            }
            log.debug(fn, `[MEMO TRACE] After paymentDefaults, memo = "${pymt.getValue({fieldId:'memo'})}"`)
        }

        // PTM23152 - Add support a plugin to mutate the payment record above before saving.
        // Try to load the plugin, call the plugin method, and save the returned record.
        // If the plugin fails to load/call/save, fall back to the default CashApp record. 
        let createPayment = true
        let plugin = null
        let pluginData = {}
        try {
            const pl = getPlugin(batchId)
            plugin = pl.plugin
            pluginData = pl.pluginData
        } catch(e) {
            log.error(fn, `Failed to get plugin. ${e.message}. ${e.stack}`)
        }
      
        log.debug(fn, `[MEMO TRACE] Before plugin.beforeCreatePayment: memo = "${pymt.getValue({fieldId:'memo'})}", pluginData.configId = ${pluginData?.configId}, hasPlugin = ${!!plugin}`)
        if (!!plugin) {
            // try {
                createPayment = plugin.beforeCreatePayment(pymt, batchId, cashAppTranId, fields, matches, credits, {setup, ...pluginData}, didRetry)
            // } catch (err) {
            //     log.error(fn, `Failed to execute Plugin method beforeCreatePayment. ${err.message}. ${err.stack}`)
            // }
        }

        log.debug(fn, `[MEMO TRACE] After plugin.beforeCreatePayment: memo = "${pymt.getValue({fieldId:'memo'})}", custbody_tb_custom_memo = "${pymt.getValue({fieldId:'custbody_tb_custom_memo'})}"`)
        log.audit(fn, `Final Payment Amount: ${pymt.getValue({fieldId:'payment'})}`)

        // Set Posting Period
        const periodId = pymt.getValue({fieldId:'postingperiod'})
        log.debug(`${fn}: Before resolve posting period`, {periodId, date, dt})
        const postingPeriod = priCommon.resolvePostingPeriod({date:dt, lockCondition:'SKIP_AR_LOCKED'})
        log.debug(fn, `Posting Period: ${postingPeriod}`)
        // pymt.setValue({fieldId:'postingperiod', value:postingPeriod})

        let pymtId
        if (createPayment === false) {
            log.audit(fn, `Payment not created due to plugin.beforeCreatePayment returning false`)
            throw new Error('Payment not created due to plugin.beforeCreatePayment returning false')
        } else if (createPayment === true) {
            // Save
            pymtId = pymt.save({ignoreMandatoryFields:true})
            log.audit(`${fn}: Payment created`, pymtId)
        } else if (!isNaN(createPayment)) {
            pymtId = createPayment
        }

        // PTM23152 - Add support a plugin to mutate the payment record after it is saved.
        if (!!plugin) {
            try {
                plugin.afterCreatePayment(pymtId, batchId, cashAppTranId, fields, matches, credits, {setup, ...pluginData}, didRetry)
            } catch (err) {
                log.error(fn, `Failed to call Plugin method afterCreatePayment. ${err.message}`)
            }
        }

        return [pymtId, fxJournalId, fxDifference]
    }

    function offsetDummyPayment(dummyPaymentId, offsettingAmount, dummyCustomerId) {
        const fn = `${scriptName}.offsetDummyPayment: ${dummyPaymentId}`
        const type = 'customerpayment'
        try {
            let linkedDummyPaymentApplications = []
            try {
                linkedDummyPaymentApplications = runQuery(`
                    select count(*) as count
                    from nexttransactionlink
                    where nextdoc = ${dummyPaymentId}
                    and linktype = 'Payment'
                `)
            } catch(_){}
            if (linkedDummyPaymentApplications?.length > 0 && linkedDummyPaymentApplications?.[0]?.count > 0) {
                throw new Error(`Dummy payment ${dummyPaymentId} has been applied to other invoices. Cannot modify dummy payment.`)
            }
        } catch (err) {
            log.error(fn, `Failed to get linked dummy payment applications. ${err.message}`)
            return
        }
        let pymt = null, currentAmount = 0, periodId = null
        try {
            pymt = record.load({type, id:dummyPaymentId, isDynamic:true})
            currentAmount = pymt.getValue({fieldId:'payment'})
            periodId = pymt.getValue({fieldId:'postingperiod'})
            log.debug(fn, {currentAmount, periodId})
        } catch (err) {
            log.error(fn, `Failed to load dummy payment. ${err.message}`)
            return
        }
        if (String(priCommon.resolvePostingPeriod({periodId, lockCondition:'SKIP_AR_LOCKED'})) !== String(periodId)) {
            throw new Error(`Dummy payment ${dummyPaymentId} is in a closed accounting period. Cannot modify dummy payment.`)
        }
        if (!!dummyCustomerId && String(dummyCustomerId) !== String(pymt.getValue('customer'))) {
            throw new Error(`Dummy payment ${dummyPaymentId} is not for the dummy customer ${dummyCustomerId}`)
        }
        // const voided = pymt.getValue({fieldId:'voided'})
        // if (voided || voided === 'T') {
        //     // Create new payment if voided and amount > 0?
        //     log.audit(`${fn} Cannot set amount of voided payment`, JSON.stringify({dummyPaymentId, amount}))
        //     return
        // }
        newAmount = currentAmount - offsettingAmount
        log.debug(fn, {offsettingAmount, newAmount})
        if (parseFloat(Number(newAmount).toFixed(2)) < .01) {
            try {
                // Detach the cash-app link before deleting so the PRI_CashApp_UE_CustomerPayment
                // DELETE handler early-returns and does NOT call syncPaymentChange — which would
                // race with the caller (e.g. applyCashAppTransaction) and can flip the cash-app
                // transaction's matchstatus to APPLIED_PARTIAL after a write-off JE has been created.
                try {
                    record.submitFields({type, id:dummyPaymentId, values:{custbody_pri_cashapp_transaction:''}})
                } catch (detachErr) {
                    log.error(fn, `Failed to detach cash-app link from dummy ${dummyPaymentId} before delete. ${detachErr.message}`)
                }
                record.delete({type, id:dummyPaymentId})
                log.audit(fn, `Dummy payment ${dummyPaymentId} deleted due to new amount: ${newAmount}`)
            } catch (err) {
                log.audit(`${fn}: Delete payment error`, {name:err.name,message:err.message,stack:err.stack})
            }
        } else {
            log.debug(fn, `Pre save dummy payment. New Amount ${newAmount}`)
            pymt.setValue({fieldId:'payment',value:newAmount})
            pymt.save({ignoreMandatoryFields:true})
            log.audit(fn, `Dummy payment ${dummyPaymentId} updated to new amount: ${newAmount}`)
        }
    }

    function setDummyPaymentAmount(dummyPaymentId, amount, dummyCustomerId) {
        const fn = `${scriptName}.setDummyPaymentAmount: ${dummyPaymentId}`
        if (!dummyPaymentId) {
            log.audit(fn, `Dummy payment ID not found`)
            return null
        }
        const type = 'customerpayment'
        // const pymt = record.load({type, id:dummyPaymentId, isDynamic:true})
        let pymt = null
        try {
            const linkedDummyPaymentApplications = runQuery(`
                select count(*) as count
                from nexttransactionlink
                where nextdoc = ${dummyPaymentId}
                and linktype = 'Payment'
            `)
            if (linkedDummyPaymentApplications.length > 0 && linkedDummyPaymentApplications[0].count > 0) {
                throw new Error(`Dummy payment ${dummyPaymentId} has been applied to other invoices. Cannot modify dummy payment.`)
            }
        } catch (err) {
            log.error(fn, `Failed to get linked dummy payment applications. ${err.message}`)
            return
        }
        try {
            pymt = record.load({type, id:dummyPaymentId, isDynamic:true}),
                periodId = pymt.getValue({fieldId:'postingperiod'})
            if (String(priCommon.resolvePostingPeriod({periodId, lockCondition:'SKIP_AR_LOCKED'})) !== String(periodId)) {
                throw new Error(`Dummy payment ${dummyPaymentId} is in a closed accounting period. Cannot modify dummy payment.`)
            }
            if (!!dummyCustomerId && String(dummyCustomerId) !== String(pymt.getValue('customer'))) {
                throw new Error(`Dummy payment ${dummyPaymentId} is not for the dummy customer ${dummyCustomerId}`)
            }
        } catch (err) {
            log.error(fn, `Failed to load dummy payment. ${err.message}`)
            return
        }
        // const voided = pymt.getValue({fieldId:'voided'})
        // if (voided || voided === 'T') {
        //     // Create new payment if voided and amount > 0?
        //     log.audit(`${fn} Cannot set amount of voided payment`, JSON.stringify({dummyPaymentId, amount}))
        //     return
        // }
        if (amount < .01) {
            try {
                // Detach the cash-app link before deleting so the PRI_CashApp_UE_CustomerPayment
                // DELETE handler early-returns and does NOT call syncPaymentChange — which would
                // race with the caller (e.g. applyCashAppTransaction) and can flip the cash-app
                // transaction's matchstatus to APPLIED_PARTIAL after a write-off JE has been created.
                try {
                    record.submitFields({type, id:dummyPaymentId, values:{custbody_pri_cashapp_transaction:''}})
                } catch (detachErr) {
                    log.error(fn, `Failed to detach cash-app link from dummy ${dummyPaymentId} before delete. ${detachErr.message}`)
                }
                record.delete({type, id:dummyPaymentId})
                log.audit(fn, `Dummy payment ${dummyPaymentId} deleted due to new amount: ${amount}`)
                return null
            } catch (err) {
                log.audit(`${fn}: Delete payment error`, JSON.stringify(err))
                return dummyPaymentId
            }
        } else {
            pymt.setValue({fieldId:'payment',value:amount})
            const id = pymt.save({ignoreMandatoryFields:true})
            log.audit(fn, `Dummy payment ${dummyPaymentId} updated to new amount: ${amount}`)
            return id
        }
    }

    function incrementPaymentAmount(paymentId, incrementalAmount) {
        const fn = `${scriptName}.incrementPaymentAmount: ${paymentId}`
        const type = 'customerpayment'
        const pymt = record.load({type, id:paymentId, isDynamic:true})
        const currentAmount = pymt.getValue({fieldId:'payment'})
        const newAmount = currentAmount + incrementalAmount
        pymt.setValue({fieldId:'payment',value:newAmount})
        const id = pymt.save({ignoreMandatoryFields:true})
        log.audit(fn, `Payment ${paymentId} updated to new amount: ${newAmount}`)
        return id
    }

    function writeOffOverpayment(cashAppTranId, userSpecifiedAccount = null) {
        const fn = `${scriptName}.writeOffOverpayment for ${cashAppTranId}`
        log.debug(fn)
        
        const {
            batchId,
            date,
            dummyPayment,
            customerRecordId,
            paymentMethod,
            paymentAmount,
            checkNo,
            location,
            foreignCurrency, foreignRemitAmount
        } = lookupCashAppTransaction(cashAppTranId)

        const { total: dummyTotal } = lookupPayment(dummyPayment)
        const total = dummyTotal || paymentAmount
        if (total < 0.01) return

        const { defaultSubsidiary, defaultLocation, defaultCurrency } = lookupCashAppSetupByBatch(batchId)

        const writeOffTransaction = writeOff(batchId,cashAppTranId,total,'overpayment',customerRecordId,null,date,location,defaultSubsidiary, userSpecifiedAccount)

        const payments = queryPaymentsAndWriteOffs(cashAppTranId, dummyPayment)
        log.debug(fn, JSON.stringify({payments}))
        if (payments.length) {
            const newMatch = {}
            newMatch[writeOffTransaction.toString()] = { apply:total }
            createPayment(batchId, cashAppTranId, {
                date, 
                customer:customerRecordId, 
                location:location||defaultLocation, 
                subsidiary:defaultSubsidiary,
                amount:(payments[0].amount + total),
                paymentMethod:paymentMethod?.value,
                checkNumber:checkNo,
                memo:'CashApp Overpayment',
                currency:(foreignCurrency || defaultCurrency)
            }, newMatch)
        }

        if (!!writeOffTransaction)
            try {
                setDummyPaymentAmount(dummyPayment, 0)
            } catch (_){}
    }

    function writeOff(batchId, cashAppTranId, writeOffAmount, type = 'overpayment', customer, invoice, date, location, subsidiary, userSpecifiedAccount = null, currency = null) {
        const fn = `${scriptName}.writeOff: ${cashAppTranId}`
        log.debug(fn, {
            batchId, cashAppTranId, writeOffAmount, type, customer, invoice, date, location, subsidiary, currency
        })

        const { defaultSubsidiary, defaultLocation, writeOffThreshold, arAccount, writeOffDebitAccount, writeOffCreditAccount, 
            writeOffBankFeeAccount, writeOffBankFeeCreditAccount, writeOffMemo, writeOffRecordType, dummyCustomer, defaultCurrency
        } = lookupCashAppSetupByBatch(batchId)

        let invoiceArAcct = null
        try {
            log.debug(fn, `Looking up AR Account for ${invoice}`)
            const lookup = search.lookupFields({type:'transaction', id:parseInt(invoice), columns:['account']})?.account?.[0]?.value
            if (!!lookup) invoiceArAcct = lookup
        } catch (err) {
            log.error(fn, `Failed to change AR Account. ${err.message}. ${err.stack}`)
        }

        let debitAcct = type == 'underpayment' ? writeOffDebitAccount : writeOffCreditAccount,
            creditAcct = type == 'underpayment' ? writeOffCreditAccount : writeOffDebitAccount
        if (!!userSpecifiedAccount) {
            if (type == 'underpayment') {
                debitAcct = userSpecifiedAccount
            } else {
                creditAcct = userSpecifiedAccount
            }
        }
        if (type == 'bankfeeunderpayment') {
            debitAcct = writeOffBankFeeAccount
            creditAcct = writeOffBankFeeCreditAccount || writeOffCreditAccount
            if (debitAcct === arAccount && invoiceArAcct !== arAccount)
                debitAcct = invoiceArAcct
            if (creditAcct === arAccount && invoiceArAcct !== arAccount)
                creditAcct = invoiceArAcct
        }

        const amount = Math.abs(writeOffAmount)
        if (type != 'bankfeeunderpayment' && (amount < 0.01 || amount > writeOffThreshold))
            throw new Error(`Cannot write off CashApp Transaction ${cashAppTranId}. writeOffAmount not valid. Amount = ${amount}, Threshold = ${writeOffThreshold}`)

        // Underpayments must have an inv/cust
        if (type == 'underpayment' && (!customer || !invoice))
            throw new Error(`Cannot write off CashApp Transaction ${cashAppTranId}. Underpayments require a customer and invoice.`)

        // Overpayments should have an inv and cust, 
        // but fallbact to the default customer if none defined
        if (type == 'overpayment' && !customer)
            customer = dummyCustomer
        
        const woMemo = `${writeOffMemo!=''?writeOffMemo:'Write-off'} - ${type=='overpayment'?'Over':'Under'}payment`

        // Create writeoff transaction
        let rectype = writeOffRecordType,
            writeOffTransaction = null
        
        // PTM23152 - Add support a plugin to overwite the writeoff process below.
        log.debug(fn, `Getting plugin for batchId ${batchId}`)
        let plugin = null
        let pluginData = {}
        try {
            const pl = getPlugin(batchId)
            plugin = pl.plugin
            pluginData = pl.pluginData
            log.debug(fn, `Plugin: ${plugin}`)
        } catch(e) {
            log.error(fn, `Failed to get plugin. ${e.message}. ${e.stack}`)
        }
        if (!!plugin) {
            log.debug(fn, `Calling Plugin method createWriteOffTransaction`)
            try {
                writeOffTransaction = plugin.createWriteOffTransaction(batchId, cashAppTranId, type, {
                    type, recordType:rectype, date, customer, amount, debitAcct, creditAcct, memo:woMemo, invoice,
                    subsidiary:subsidiary||defaultSubsidiary, location:location||defaultLocation, currency:(currency || defaultCurrency)
                }, pluginData)
            } catch (err) {
                log.error(fn, `Failed to call Plugin method createWriteOffTransaction. ${err.message}`)
            }
        }

        // Create a custom transaction writeoff if one is not already created
        if (!writeOffTransaction && writeOffRecordType.indexOf('customtransaction') === 0)
            try {
                writeOffTransaction = createWriteOffTransaction(rectype, batchId, cashAppTranId, date, subsidiary||defaultSubsidiary, 
                    customer, amount, debitAcct, creditAcct, woMemo, location||defaultLocation, type, (currency || defaultCurrency))
            } catch (err) {
                log.error(fn, JSON.stringify({name:err.name,message:err.message}))
            }

        // If the writeoff did not get created above (or failed)
        if (!writeOffTransaction) {
            rectype = 'journalentry'
            writeOffTransaction = createWriteOffJE(batchId, cashAppTranId, date, subsidiary||defaultSubsidiary, customer, amount, 
                debitAcct, creditAcct, woMemo, location||defaultLocation, type, (currency || defaultCurrency))
        }
        
        // If doing an underpayment writeoff, apply the writeoff to the invoice directly
        if (type == 'underpayment' && !!writeOffTransaction) {
            const woMatch = {}, creditMatch = {}
            woMatch[invoice] = { apply:amount }
            creditMatch[writeOffTransaction] = { apply:amount }
            log.debug(fn, `Creating payment for underpayment writeoff. CashApp Trans ${cashAppTranId}, Invoice: ${invoice} (${amount})`)
            createPayment(batchId, cashAppTranId, 
                { date, subsidiary:subsidiary||defaultSubsidiary, customer, location, amount:0, currency:(currency || defaultCurrency) }, 
                woMatch, creditMatch)
        }

        log.audit(fn, `Record type ${rectype}, id ${writeOffTransaction} created (Write off type = ${type}, amount = ${amount}).`)
        return writeOffTransaction
    }

    function createWriteOffTransaction(recType, batchId, cashAppTranId, date, subsidiary, customer, amount, debitAcct, creditAcct, memo, location, type, currency) {
        const fn = `${scriptName}.createWriteOffTransaction: ${recType}`

        const tran = record.create({type:recType}),
            sublistId = 'line'  
        log.audit(fn, `Custom Write Off transaction (type=${recType}) initiated`)

        tran.setValue({fieldId:'subsidiary',value:subsidiary})
        tran.setValue({fieldId:'trandate',value:formatDate(date)})
        tran.setValue({fieldId:'custbody_pri_cashapp_batch',value:batchId})
        tran.setValue({fieldId:'custbody_pri_cashapp_transaction',value:cashAppTranId})
        if (!!memo)
            tran.setValue({fieldId:'memo',value:truncMemo(memo)})     
        if (location)
            tran.setValue({fieldId:'location',value:location}) 
        if (!!currency)
            tran.setValue({fieldId:'currency',value:currency})

        // debit
        tran.setSublistValue({line:0,sublistId,fieldId:'account',value:debitAcct})
        tran.setSublistValue({line:0,sublistId,fieldId:'debit',value:amount})
        tran.setSublistValue({line:0,sublistId,fieldId:'entity',value:customer})
        if (!!customer)
            tran.setSublistValue({line:1,sublistId,fieldId:'entity',value:customer})
        tran.setSublistValue({line:0,sublistId,fieldId:'memo',value:memo})

        // credit
        tran.setSublistValue({line:1,sublistId,fieldId:'account',value:creditAcct})
        tran.setSublistValue({line:1,sublistId,fieldId:'credit',value:amount})
        if (!!customer)
            tran.setSublistValue({line:1,sublistId,fieldId:'entity',value:customer})
        tran.setSublistValue({line:1,sublistId,fieldId:'memo',value:memo})
        
        tran.setValue({fieldId:'custbody_pri_cashapp_overpymtwriteoff',value:type=='overpayment'})
        tran.setValue({fieldId:'custbody_pri_cashapp_writeofftype',value:type})

        const tranId = tran.save({ignoreMandatoryFields:true})
        log.audit(fn, `Custom Write Off transaction (type=${recType}) ${tranId} created.`)

        return tranId
    }

    function createWriteOffJE(batchId, cashAppTranId, date, subsidiary, customer, amount, debitAcct, creditAcct, memo, location, type, currency) {
        const fn = `${scriptName}.createWriteOffJE`

        const je = record.create({type:'journalentry'}),
            sublistId = 'line'

        je.setValue({fieldId:'subsidiary',value:subsidiary})
        je.setValue({fieldId:'trandate',value:formatDate(date)})
        je.setValue({fieldId:'approved',value:true})
        je.setValue({fieldId:'approvalstatus', value:2})
        je.setValue({fieldId:'custbody_pri_cashapp_batch',value:batchId})
        je.setValue({fieldId:'custbody_pri_cashapp_transaction',value:cashAppTranId})
        if (!!memo)
            je.setValue({fieldId:'memo',value:truncMemo(memo)})
        if (!!currency)
            je.setValue({fieldId:'currency',value:currency})

        // debit
        je.setSublistValue({line:0,sublistId,fieldId:'account',value:debitAcct})
        je.setSublistValue({line:0,sublistId,fieldId:'debit',value:amount})
        je.setSublistValue({line:0,sublistId,fieldId:'entity',value:customer})
        if (!!customer)
            je.setSublistValue({line:1,sublistId,fieldId:'entity',value:customer})
        je.setSublistValue({line:0,sublistId,fieldId:'memo',value:memo})
        if (!!location)
            je.setSublistValue({line:0,sublistId,fieldId:'location',value:location})

        // credit
        je.setSublistValue({line:1,sublistId,fieldId:'account',value:creditAcct})
        je.setSublistValue({line:1,sublistId,fieldId:'credit',value:amount})
        if (!!customer)
            je.setSublistValue({line:1,sublistId,fieldId:'entity',value:customer})
        je.setSublistValue({line:1,sublistId,fieldId:'memo',value:memo})
        if (!!location)
            je.setSublistValue({line:1,sublistId,fieldId:'location',value:location})

        je.setValue({fieldId:'custbody_pri_cashapp_overpymtwriteoff',value:type=='overpayment'})
        je.setValue({fieldId:'custbody_pri_cashapp_writeofftype',value:type})

        const jeId = je.save({ignoreMandatoryFields:true})
        log.audit(fn, `Journal Entry ${jeId} created.`)

        return jeId
    }

    //#endregion Customer Payment Methods
    /* ====================================================================================================== */
    //#region Matching Rule Methods

    function getCashAppMatchingRuleKeys() {
        const Cache = cache.getCache({name:PRI_CASHAPP_CACHE_KEY})
        return JSON.parse(Cache.get({key:'MatchingRuleKeys',loader:loadCashAppMatchingRuleKeys}))
    }

    function loadCashAppMatchingRuleKeys() {
        let rules = []
        search.create({
            type:'customrecord_pri_cashapp_matching_rule',
            filters:[
                {name:'isinactive',operator:search.Operator.IS,values:false},
            ],
            columns:[
                {name:'custrecord_pri_cashapp_mtchrule_key',summary:search.Summary.GROUP}
            ]
        }).run().each(rule => {
            rules.push(rule.getValue({name:'custrecord_pri_cashapp_mtchrule_key',summary:search.Summary.GROUP}))
            return true
        })
        return rules
    }

    function getNegatedMatchingRules(setupId) {
        // const Cache = cache.getCache({name:PRI_CASHAPP_CACHE_KEY})
        // return JSON.parse(Cache.get({key:'NegatedRules',loader:() => loadNegatedMatchingRules(setupId) }))
        return loadNegatedMatchingRules(setupId)
    }

    function loadNegatedMatchingRules(setupId) {
        const fn = `${scriptName}.loadNegatedMatchingRules`
        let rules = []
        search.create({
            type:'customrecord_pri_cashapp_matching_rule',
            filters:[
                {name:'isinactive',operator:search.Operator.IS,values:false},
                {name:'custrecord_pri_cashapp_mtchrule_setup',operator:search.Operator.IS,values:setupId},
                {name:'custrecord_pri_cashapp_mtchrule_negated',operator:search.Operator.IS,values:true},
            ],
            columns:[
                {name:'custrecord_pri_cashapp_mtchrule_key'},
                {name:'custrecord_pri_cashapp_mtchrule_value'},
                {name:'custrecord_pri_cashapp_mtchrule_priority'}
            ]
        }).run().each(rule => {
            rules.push({
                key:rule.getValue({name:'custrecord_pri_cashapp_mtchrule_key'}),
                value:rule.getValue({name:'custrecord_pri_cashapp_mtchrule_value'}),
                priority:rule.getValue({name:'custrecord_pri_cashapp_mtchrule_priority'})
            })
            return true
        })
        // log.debug(fn, JSON.stringify({rules}))
        return rules
    }

    function createCashAppMatchingRules(batchId, cashAppTranId, customerId) {
        const fn = `${scriptName}.createCashAppMatchingRules`
        // Try to load the plugin, call the plugin method, and save the returned record.
        // If the plugin fails to load/call/save, fall back to the default CashApp record.
        let plugin = null
        let pluginData = {}
        try {
            const pl = getPlugin(batchId)
            plugin = pl.plugin
            pluginData = pl.pluginData
        } catch(e) {
            log.error(fn, `Failed to get plugin. ${e.message}. ${e.stack}`)
        }
        if (!!plugin) {
            try {
                plugin.createCashAppMatchingRules(cashAppTranId, customerId, pluginData)
                // plugin will callback to createCashAppMatchingRule defined below
            } catch (err) {
                log.error(fn, `Failed to call Plugin method createCashAppMatchingRules. ${err.message}`)
            }
        }
    }
    
    function queryMatchingOpenTransactionsByRule(key, values) {
        const fn = `${scriptName}.queryMatchingOpenTransactionsByRule`
        let q = 
            `SELECT 
                r.id as rule_id, 
                r.custrecord_pri_cashapp_mtchrule_priority as priority, 
                r.custrecord_pri_cashapp_mtchrule_customer,
                t.entity, 
                BUILTIN.DF(t.entity) as entityname, 
                t.id, 
                t.tranid, 
                t.trandate,
                t.recordtype,
                t.status,
                BUILTIN.DF(t.status) as statuslabel,
                t.currency,
                BUILTIN.DF(t.currency) as currencyname,
                t.exchangerate,
                t.foreignTotal as total,
                t.foreignAmountUnpaid as unpaid
            FROM customrecord_pri_cashapp_matching_rule as r
            LEFT JOIN transaction as t
                ON t.entity = r.custrecord_pri_cashapp_mtchrule_customer
            WHERE r.isinactive = 'F'
                AND t.void = 'F'
                AND t.recordtype IN ('invoice')
                AND t.billingStatus = 'T'
                AND r.custrecord_pri_cashapp_mtchrule_bakup_ln IS NULL
                AND r.custrecord_pri_cashapp_mtchrule_negated = 'F'
                AND r.custrecord_pri_cashapp_mtchrule_key = '${key}'`
        if (values.length === 1) {
            q += `\n  AND r.custrecord_pri_cashapp_mtchrule_value = '${values[0].replace(/\'/g,"''")}'`
        } else if (values.length > 1) {
            q += '\nAND ('
            for (const [i,val] of values.entries()) {
                if (i !== 0)
                    q += '\nOR '
                q += `r.custrecord_pri_cashapp_mtchrule_value = '${val.replace(/\'/g,"''")}'`
            }
            q += ')'
        }
        log.debug(fn, {query:q})
        return runQuery(q)
    }

    function queryOpenTransactionsByBackupRule(key, values) {
        const fn = `${scriptName}.queryOpenTransactionsByBackupRule`
        let q = 
            `SELECT 
                r.id as rule_id, 
                r.custrecord_pri_cashapp_mtchrule_priority as priority, 
                r.custrecord_pri_cashapp_mtchrule_customer, 
                r.custrecord_pri_cashapp_mtchrule_bakup_ln AS backuplineid,
                r.custrecord_pri_cashapp_mtchrule_value AS rule_value,
                t.entity, 
                BUILTIN.DF(t.entity) as entityname, 
                t.id, 
                t.tranid, 
                t.trandate,
                t.recordtype,
                t.status,
                l.subsidiary,
                BUILTIN.DF(t.status) as statuslabel,
                t.currency,
                BUILTIN.DF(t.currency) as currencyname,
                t.exchangerate,
                t.foreignTotal as total,
                t.foreignAmountUnpaid as unpaid,
            FROM customrecord_pri_cashapp_matching_rule as r
            JOIN customrecord_pri_cashapp_backup_line AS bl
                ON bl.id = r.custrecord_pri_cashapp_mtchrule_bakup_ln
            JOIN transaction as t
                ON t.id = bl.custrecord_pri_cashapp_bakline_trans
            JOIN transactionline as l
                ON l.transaction = t.id
                AND l.mainline = 'T'
            WHERE r.isinactive = 'F'
                AND t.void = 'F'
                AND t.recordtype IN ('invoice')
                AND t.billingStatus = 'T'
                AND r.custrecord_pri_cashapp_mtchrule_negated = 'F'
                AND r.custrecord_pri_cashapp_mtchrule_key = '${key}'`
        if (values.length === 1) {
            q += `\n  AND r.custrecord_pri_cashapp_mtchrule_value = '${values[0].replace(/\'/g,"''")}'`
        } else if (values.length > 1) {
            q += '\nAND ('
            for (const [i,val] of values.entries()) {
                if (i !== 0)
                    q += '\nOR '
                q += `r.custrecord_pri_cashapp_mtchrule_value = '${val.replace(/\'/g,"''")}'`
            }
            q += ')'
        }
        log.debug(fn, {query:q})
        return runQuery(q)
    }

    function createCashAppMatchingRule(configId, customerId, key, value, priority = 100, negated = false) {
        const fn = `${scriptName}.createCashAppMatchingRule`
        if (!customerId 
            || typeof key !== 'string' || !key 
            || typeof value !== 'string' || !value 
            || priority < 100 || priority > 998) {
            throw new Error('Parameters not defined correctly')
        }
        key = key.endsWith('=') ? key : `${key}=`
        try {
            const rec = record.create({type:'customrecord_pri_cashapp_matching_rule'})
            if (configId)
                rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_setup',value:configId})
            rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_customer',value:customerId})
            rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_key',value:key})
            rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_value',value:value})
            rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_priority',value:priority})
            rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_negated',value: negated===true })
            const id = rec.save()

            log.debug(fn, `Rule ${id} created. Config = ${configId}, Customer = ${customerId}, Key = '${key}', Value = ${value}, Prio = ${priority}`)
            return id
        } catch(er) {
            log.debug(`${fn}: Failed to create rule`, {name:er.name, message:er.message})
        }
    }

    function createCashAppBackupMatchingRule(configId, backupLineId, customerId, transactionId = null, key, value, priority = 100, negated = false) {
        const fn = `${scriptName}.createCashAppBackupMatchingRule`
        if (!backupLineId 
            || typeof key !== 'string' || !key 
            || typeof value !== 'string' || !value 
            || priority < 100 || priority > 998) {
            throw new Error('Parameters not defined correctly')
        }
        key = key.endsWith('=') ? key : `${key}=`
        try {
            const rec = record.create({type:'customrecord_pri_cashapp_matching_rule'})
            if (configId)
                rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_setup',value:configId})
            rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_bakup_ln',value:backupLineId})
            rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_customer',value:customerId})
            if (!!transactionId)
                rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_txn',value:transactionId})
            rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_key',value:key})
            rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_value',value:value})
            rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_priority',value:priority})
            rec.setValue({fieldId:'custrecord_pri_cashapp_mtchrule_negated',value: negated===true })
            const id = rec.save()

            log.debug(fn, `Rule ${id} created. Config = ${configId}, Backup Line = ${backupLineId}, Customer = ${customerId}, Transaction = ${transactionId}, Key = '${key}', Value = ${value}, Prio = ${priority}`)
            return id
        } catch(er) {
            log.debug(`${fn}: Failed to create rule`, {name:er.name, message:er.message})
        }
    }

    function getCashAppMatchingRulesByCustomer(configId, customerId) {
        const fn = `${scriptName}.getCashAppMatchingRulesByCustomer`
        let q = `SELECT
                R.custrecord_pri_cashapp_mtchrule_key AS key,
                R.custrecord_pri_cashapp_mtchrule_value AS value,
                R.custrecord_pri_cashapp_mtchrule_priority AS priority,
                R.custrecord_pri_cashapp_mtchrule_setup AS config,
                R.custrecord_pri_cashapp_mtchrule_bakup_ln AS backuplineid,
                BL.custrecord_pri_cashapp_bakline_trans AS transactionid,
                T.recordtype AS transactiontype,
                T.foreignTotal AS total,
                T.foreignAmountUnpaid AS unpaid
            FROM customrecord_pri_cashapp_matching_rule AS R
            LEFT JOIN customrecord_pri_cashapp_backup_line AS BL
                ON BL.id = R.custrecord_pri_cashapp_mtchrule_bakup_ln
            LEFT JOIN transaction AS T
                ON T.id = BL.custrecord_pri_cashapp_bakline_trans
            WHERE R.custrecord_pri_cashapp_mtchrule_customer = ${customerId}`
        if (!!configId)
            q += `\n AND (custrecord_pri_cashapp_mtchrule_setup = ${configId} OR custrecord_pri_cashapp_mtchrule_setup IS NULL)`

        const results = runQuery(q)

        let rules = {}
        for (const rule of results) {
            if (!rules.hasOwnProperty(rule.key))
                rules[rule.key] = []
            rules[rule.key].push({ value:rule.value, priority:rule.priority })
        }
        return rules
    }

    //#endregion Matching Rule Methods
    /* ====================================================================================================== */
    //#region Backup Record Methods

    const BACKUP_STATUS = {
        NOT_STARTED: '1',
        NEEDS_REVIEW: '2',
        READY_TO_PROCESS: '3',
        PROCESSING: '4',
        COMPLETED: '5',
        SKIPPED: '6',
        FAILED: '7'
    }

    const BackupAIAppSetting = {
        application: 'Prolecto Cash Application',
        setting: 'PRI CashApp Backup AI Prompt'
    }

    /**
     * Matches a backup record to a Backup Type by trying to sequentially call each backup type's plugin script until one claims ownership.
     * 
     * @param {record.Record} backupRecord - The backup record to match
     */
    function matchBackupRecord(backupRecord) {
        const fn = `${scriptName}.matchBackupRecord`
        log.debug(fn, `Matching backup record: ${backupRecord.id}`)
        
        // GOV: 10
        const attachmentIds = []
        search.create({
            type:'customrecord_pri_cashapp_backup',
            filters: [
                {name:'isinactive', operator:search.Operator.IS, values:false},
                {name:'internalidnumber', operator:search.Operator.EQUALTO, values:backupRecord.id}
            ],
            columns: [
                {name:'internalid', join:'file'}
            ]
        }).run().each(backup => {
            attachmentIds.push(backup.getValue({name:'internalid', join:'file'}))
            return true
        })
        log.debug(fn, {attachmentIds})

        // GOV: 10
        // Load all of the Backup Types and use priority to sequentially call each plugin script.
        const backupTypes = runQuery(
            `SELECT 
                id,
                custrecord_pri_cashapp_baktype_config config,
                custrecord_pri_cashapp_baktype_prio priority,
                custrecord_pri_cashapp_baktype_plugin plugin,
                custrecord_pri_cashapp_baktype_plugdata data,
                custrecord_pri_cashapp_baktype_use_ai useai
            FROM customrecord_pri_cashapp_backup_type
            WHERE isinactive = 'F'
                AND custrecord_pri_cashapp_baktype_config IS NOT NULL
                AND custrecord_pri_cashapp_baktype_plugin IS NOT NULL
            ORDER BY custrecord_pri_cashapp_baktype_prio ASC`)

        let claimed = false,
            claimedType = null
        for (const backupType of backupTypes) {
            const plt = getBackupPlugin(backupType.plugin)
            if (plt) {
                let plData = {}
                try {
                    plData = JSON.parse(backupType.data)
                } catch (e) {}
                try {
                    claimed = plt.claimBackupRecordOwnership(backupRecord, attachmentIds, plData) === true
                    claimedType = backupType.id
                } catch (e) {
                    log.error(fn, `Backup record ${backupRecord.id} cannot be claimed by ${backupType.plugin}. ${e.message}`)
                    claimed = false
                }
            }
            if (claimed) {
                log.debug(fn, `Backup record ${backupRecord.id} claimed by ${backupType.plugin}`)
                break
            }
        }

        // If a plugin claims ownership of the backup record, set the status to "Ready to Process"
        // If no plugins can claim ownership, set the status to "Needs Review"
        const updates = {
            custrecord_pri_cashapp_bakup_status: claimed ? BACKUP_STATUS.READY_TO_PROCESS : BACKUP_STATUS.NEEDS_REVIEW
        }
        if (claimedType) {
            updates.custrecord_pri_cashapp_bakup_type = claimedType
            updates.custrecord_pri_cashapp_bakup_use_ai = backupTypes.find(bt => bt.id === claimedType)?.useai === 'T' ?? false
        }

        // record.submitFields({ type:'customrecord_pri_cashapp_backup', id:backupRecord.id, values:updates })
        const rec = record.load({type:'customrecord_pri_cashapp_backup', id:backupRecord.id})
        rec.setValue('custrecord_pri_cashapp_bakup_status', updates.custrecord_pri_cashapp_bakup_status)
        if (!!updates.custrecord_pri_cashapp_bakup_type)
            rec.setValue('custrecord_pri_cashapp_bakup_type', updates.custrecord_pri_cashapp_bakup_type)
        if (!!updates.custrecord_pri_cashapp_bakup_use_ai)
            rec.setValue('custrecord_pri_cashapp_bakup_use_ai', updates.custrecord_pri_cashapp_bakup_use_ai)
        rec.save()

        return claimed
    }

    function triggerBackupParser(backupRecordId) {
        const fn = `${scriptName}.triggerBackupParser`
        log.debug(fn, `Triggering backup parser for backup record: ${backupRecordId}`)
        
        const t = task.create({
            taskType: task.TaskType.MAP_REDUCE,
            scriptId: 'customscript_pri_cashapp_bakupprocess_mr',
            deploymentId: 'customdeploy_pri_cashapp_bakupprcs_mr',
            params: {
                'custscript_pri_cashapp_bakupid': backupRecordId
            }
        }).submit()
        log.debug(fn, `Task ${t} submitted`)
    }

    function processBackupRecord(backupId, emailData, attachmentIds, pluginId, pluginData) {
        const fn = `${scriptName}.processBackupRecord`
        log.debug(fn, `Processing backup record: ${backupId}`)
        
        const plt = getBackupPlugin(pluginId)
        if (plt) {
            const rec = record.load({type:'customrecord_pri_cashapp_backup', id:backupId})
            return plt.processBackupRecordData(rec, emailData, attachmentIds, pluginData)
        }
        return null
    }

    function getBackupAIInstructions(cashAppConfigId, emailBody = '') {
        const fn = `${scriptName}.getBackupAIInstructions: ${cashAppConfigId}`
        const basePrompt = asEngine.readAppSetting(BackupAIAppSetting)
        if (!basePrompt)
            return null

        log.debug(fn, {basePrompt})

        let additionalInstructions = '', 
            exampleOutput = 
`[
{
"invoiceNumber": "INV-001",
"amount": 100.00
},
{
"invoiceNumber": "INV-002",
"amount": 200.00
}
]`
        if (!!cashAppConfigId) {
            try {
                const lookup = search.lookupFields({
                    id:cashAppConfigId,
                    type:'customrecord_pri_cashapp_setup',
                    columns:['custrecord_pri_cashapp_setup_ai_back_ins', 'custrecord_pri_cashapp_setup_ai_back_fmt']})

                    additionalInstructions = lookup?.custrecord_pri_cashapp_setup_ai_back_ins ?? additionalInstructions
                    exampleOutput = lookup?.custrecord_pri_cashapp_setup_ai_back_fmt ?? exampleOutput
            } catch (e) {
                log.error(fn, `Failed to get additional instructions for cash app config ${cashAppConfigId}. ${e.message}`)
            }
        }

        const finalPrompt = basePrompt
            .replace('{{exampleOutput}}', exampleOutput)
            .replace('{{additionalInstructions}}', additionalInstructions)
            .replace('{{emailBody}}', emailBody)
        log.debug(fn, {finalPrompt})
        return finalPrompt
    }

    function processBackupRecordDataWithAI(backupRecord, emailBody, attachmentIds) {
        const fn = `${scriptName}.processBackupRecordDataWithAI`
        const backupType = backupRecord.getValue('custrecord_pri_cashapp_bakup_type')
        const configId = search.lookupFields({type:'customrecord_pri_cashapp_backup_type', id:backupType, columns:['custrecord_pri_cashapp_baktype_config']})
            ?.custrecord_pri_cashapp_baktype_config?.[0]?.value
        if (!!attachmentIds && attachmentIds.length) {
            const attachmentContents = []
            for (const attachmentId of attachmentIds) {
                try {
                    const attachment = file.load({id:attachmentId})
                    attachmentContents.push(attachment.getContents())
                } catch (e) {
                    log.error(fn, `Failed to get attachment contents for attachment ${attachmentId}. ${e.message}`)
                }
            }
            emailBody += `\n\nAttachment Contents:\n${attachmentContents.join('\n')}`
        }
        const prompt = getBackupAIInstructions(configId, emailBody)
        if (!prompt) {
            log.error(fn, `Failed to get prompt for backup record ${backupRecord.id}`)
            return
        }
        const llmResponse = llm.generateText({prompt})
        log.debug(fn, `LLM model: ${llmResponse.model} | LLM usage (total): ${llmResponse.usage.totalTokens} | LLM Response: ${llmResponse.text}`)

        backupRecord.setValue({fieldId: 'custrecord_pri_cashapp_bakup_use_ai', value: true})
        backupRecord.setValue({fieldId: 'custrecord_pri_cashapp_bakup_ai_data', value: `Prompt:\n${prompt}\n\n-----\n\nResponse:\n${llmResponse.text}`})
        backupRecord.save({ignoreMandatoryFields: true})

        try {
            return JSON.parse(llmResponse.text)
        } catch (e) {
            if (llmResponse.text.startsWith('```json')) {
                try {
                    return JSON.parse(llmResponse.text.replace('```json', '').replace('```', ''))
                } catch (e) {
                    log.error(fn, `Failed to parse LLM response for backup record ${backupRecord.id}. ${e.message}`)
                }
            } else {
                log.error(fn, `Failed to parse LLM response for backup record ${backupRecord.id}. ${e.message}`)
            }
        }
        return llmResponse.text
    }

    function getBackupAttachmentRows(backupId, attachment, pluginId, pluginData) {
        const fn = `${scriptName}.getBackupAttachmentRows`
        log.debug(fn, `Getting backup attachment rows for backup record: ${backupId}`)
        const plt = getBackupPlugin(pluginId)
        if (plt) {
            const data = plt.getBackupAttachmentData(backupId, {id:attachment}, pluginData)
            if (!!data && data.length)
                return data
        }
        return []
    }

    function processBackupAttachmentRow(backupId, attachmentId = null, rowData, pluginId, pluginData) {
        const fn = `${scriptName}.processBackupAttachmentRow`
        log.debug(fn, `Processing backup attachment row for attachment ${attachmentId}. Plugin = ${pluginId}`)
        
        const plt = getBackupPlugin(pluginId)
        const errors = []
        let attachmentRowIdentifiers = []
        if (plt) {
            try {
                const backupLine = record.create({type:'customrecord_pri_cashapp_backup_line'})
                backupLine.setValue('custrecord_pri_cashapp_backup', backupId)
                backupLine.setValue('custrecord_pri_cashapp_bakline_data', JSON.stringify(rowData))
                const backupLineId = backupLine.save({ignoreMandatoryFields: true})

                const id = plt.processBackupAttachmentRowData(backupLineId, attachmentId, rowData, pluginData)
                if (!!id && !attachmentRowIdentifiers.includes(id)) {
                    attachmentRowIdentifiers.push(id)
                }
            } catch (e) {
                log.error(fn, `Failed to execute Plugin method processBackupAttachmentRowData. ${e.message}`)
                errors.push(`Failed to process attachment ${attachmentId}. ${e.message}`)
            }
        }

        return { errors, identifiers:attachmentRowIdentifiers }
    }

    function getTransactionMatchQueryModifierForBackup(backupId, plugin, pluginData, identifiers) {
        const fn = `${scriptName}.getTransactionMatchQueryModifierForBackup`
        log.debug(fn, `Getting transaction match query modifier for backup. Plugin = ${plugin}`)
        
        let mod = ''
        const plt = getBackupPlugin(plugin)
        if (plt) {
            try {
                mod = plt.getTransactionQueryModifier(backupId, pluginData, identifiers)
            } catch(e) {
                log.error(fn, `Failed to compile transaction match query modifiers for backup ${backupId}. ${e.message}`)
                errors.push(`Failed to compile transaction match query modifiers for backup ${backupId}. ${e.message}`)
            }
        }

        return mod
    }


    //#endregion Backup Record Methods
    /* ====================================================================================================== */
    //#region Plugin Methods

    const PLUGIN_FILE_TYPE = {
        BAI2toJSON: '1',
        LockboxToJSON: '2',
        CSV: '3'
    }
    
    const PLUGIN_IMPL_TYPE = {
        BAI2toJSON: 'customscript_pri_cashapp_plt',
        LockboxToJSON: 'customscript_pri_cashapp_plt',//For Later
        CSV: 'customscript_pri_cashapp_plt'
    }

    function getPlugin(batchId) {
        const fn = `${scriptName}.getPlugin`
        let dummyObj = { plugin:null, pluginData: null }

        if (!batchId) {
            log.error(fn, `No batchId provided`)
            return dummyObj
        }

        const lookup = search.lookupFields({
                type:'customrecord_pri_cashapp_batch',
                id:batchId,
                columns:[
                    'custrecord_pri_cashapp_batch_setup',
                    'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_plugin',
                    'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_filetype',
                    'custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_plugindata'
                ]
            }),
            configId = lookup.custrecord_pri_cashapp_batch_setup?.[0]?.value,
            fileType = lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_filetype']?.[0]?.value,
            pluginName = lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_plugin'],
            pluginDataStr = lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_plugindata']

        log.debug(fn, JSON.stringify({
            batchId, configId, fileType,
            fileTypeRaw: lookup['custrecord_pri_cashapp_batch_setup.custrecord_pri_cashapp_setup_filetype'],
            pluginName,
            pluginDataStr: pluginDataStr ? pluginDataStr.substring(0, 200) : null
        }))

        const pluginKey = Object.keys(PLUGIN_FILE_TYPE).find(k => PLUGIN_FILE_TYPE[k] == fileType),
            type = PLUGIN_IMPL_TYPE[pluginKey]

        log.debug(fn, JSON.stringify({
            pluginKey: pluginKey || null,
            type: type || null,
            availableFileTypes: PLUGIN_FILE_TYPE,
            availableImplTypes: PLUGIN_IMPL_TYPE
        }))

        if (!type){
            log.error(fn, `No plugin type found for file type ${fileType}. pluginKey=${pluginKey}, batchId=${batchId}, configId=${configId}`)
            return dummyObj
        }

        let pluginData = {}
        if (pluginDataStr !== '') {
            try {
                pluginData = JSON.parse(pluginDataStr)
            } catch (_) {
                log.error(`${fn}: Cannot parse Plugin Data JSON.`, pluginDataStr)
            }
        }
        pluginData.batchId = batchId
        pluginData.configId = configId
        
        if (!pluginName) {
            log.error(fn, `No plugin name configured on CashApp Setup. batchId=${batchId}, configId=${configId}, fileType=${fileType}`)
            return dummyObj
        }

        let plug = null

        const impls = plugin.findImplementations({type, includeDefault:false})
        log.debug(fn, JSON.stringify({
            type,
            requestedPlugin: pluginName,
            foundImplementations: impls,
            foundCount: impls?.length || 0,
            matchFound: impls && impls.indexOf(pluginName) > -1
        }))

        if (impls && impls.length && impls.indexOf(pluginName) > -1) {
            log.debug(fn, `Implementation "${pluginName}" found via findImplementations — loading via N/plugin`)
            try {
                plug = plugin.loadImplementation({ type, implementation: pluginName })
            } catch (loadErr) {
                log.error(fn, `N/plugin loadImplementation failed for "${pluginName}". ${loadErr.message}`)
            }
        }

        if (!plug) {
            log.audit(fn, `N/plugin unavailable for "${pluginName}" (Suitelet/RESTlet context). Falling back to require() via script file path.`)
            try {
                plug = loadPluginViaRequire(pluginName)
            } catch (requireErr) {
                log.error(fn, `require() fallback also failed for "${pluginName}". ${requireErr.message}. batchId=${batchId}, configId=${configId}`)
                return dummyObj
            }
        }

        log.debug(fn, `Plugin loaded successfully: "${pluginName}"`)
        return {
            plugin:plug,
            pluginData
        }
    }

    /**
     * Resolves a plugin script's file path from its Script record and loads it via require([]).
     * Uses the AMD async require form, which in NetSuite's server-side environment
     * executes synchronously since modules are resolved from disk.
     * Fallback for when N/plugin is unavailable (Suitelet/RESTlet execution contexts).
     */
    function loadPluginViaRequire(scriptId) {
        const fn = `${scriptName}.loadPluginViaRequire`
        const fileId = getPluginScriptFileId(scriptId)
        if (!fileId) {
            throw new Error(`Could not resolve script file ID for "${scriptId}"`)
        }

        const f = file.load({ id: fileId })
        const fileCabinetPath = f.path
        log.debug(fn, `Script "${scriptId}" → fileId=${fileId}, fileCabinetPath=${fileCabinetPath}`)

        let modulePath = fileCabinetPath.replace(/\.js$/i, '')
        const bundleMatch = modulePath.match(/^\/SuiteBundles\/Bundle\s+(\d+)\/(.+)$/)
        if (bundleMatch) {
            modulePath = `/.bundle/${bundleMatch[1]}/${bundleMatch[2]}`
        }

        log.debug(fn, `Loading module via async require([]): "${modulePath}"`)
        let mod = null
        let loadError = null
        require([modulePath], function(loadedMod) {
            mod = loadedMod
        }, function(err) {
            loadError = err
        })

        if (loadError) {
            throw new Error(`require(["${modulePath}"]) failed: ${loadError.message || JSON.stringify(loadError)}`)
        }
        if (!mod) {
            throw new Error(`require(["${modulePath}"]) callback did not execute synchronously. Module cannot be loaded dynamically in this context.`)
        }
        log.debug(fn, `Successfully loaded "${scriptId}" via require(["${modulePath}"])`)
        return mod
    }

    function getPluginScriptFileId(scriptId) {
        const fn = `${scriptName}.getPluginScriptFileId`
        try {
            const results = runQuery(`
                SELECT s.scriptfile 
                FROM script AS s 
                WHERE s.scriptid = '${scriptId}'
            `)
            if (!results || !results.length) {
                log.error(fn, `No script record found for scriptid "${scriptId}"`)
                return null
            }
            const fileId = results[0].scriptfile
            if (!fileId) {
                log.error(fn, `Script "${scriptId}" has no file assigned`)
                return null
            }
            log.debug(fn, `Script "${scriptId}" → fileId=${fileId}`)
            return fileId
        } catch (e) {
            log.error(fn, `Failed to resolve file ID for "${scriptId}". ${e.message}`)
            return null
        }
    }

    function getBackupPlugin(scriptId) {
        const fn = `${scriptName}.getBackupPlugin`
        const plt = 'customscript_pri_cashapp_backup_plt'
        const plugins = plugin.findImplementations({type:plt, includeDefault:true})
        if (!plugins || !plugins.length) {
            log.error(fn, `Cannot find implementations for ${plt}`)
            return
        }
        if (!plugins.includes(scriptId)) {
            log.error(fn, `Cannot find implementation ${scriptId} for ${plt}`)
            return
        }

        log.debug(`${fn}: Load Implementation`, JSON.stringify({type:plt, implementation:scriptId}))
        return plugin.loadImplementation({type:plt, implementation:scriptId})
    }

    //#endregion Plugin Methods
    /* ====================================================================================================== */
    //#region Misc methods

    function getCurrencyExchangeRate(date, currency, txnCurrency, defaultCurrency) {
        const fn = `${scriptName}.getCurrencyExchangeRate`
        // log.debug(fn, `Getting currency exchange rate for ${date}, ${currency}, ${txnCurrency}, ${defaultCurrency}`)

        if (!txnCurrency || !defaultCurrency || !currency) {
            return 1
        }

        let dateStr = date
        if (typeof date === 'object') {
            // Convert Date object to MM/DD/YYYY string
            dateStr = `${String(date.getDate()).padStart(2, '0')}/${String((date.getMonth() + 1)).padStart(2, '0')}/${date.getFullYear()}`
        }
        
        let exchangeRate = 1
        try {
            exchangeRate = runQuery(
                `SELECT TOP 1
                    effectivedate,
                    basecurrency,
                    BUILTIN.DF(basecurrency) basecurrencyname,
                    transactioncurrency,
                    BUILTIN.DF(transactioncurrency) transactioncurrencyname,
                    exchangerate
                FROM currencyRate
                WHERE effectivedate <= TO_DATE('${dateStr}', 'DD/MM/YYYY')
                AND (LOWER(BUILTIN.DF(basecurrency)) = '${currency.toLowerCase()}'
                    OR LOWER(BUILTIN.DF(basecurrency)) = '${defaultCurrency.toLowerCase()}')
                AND LOWER(BUILTIN.DF(transactioncurrency)) = '${txnCurrency.toLowerCase()}'
                order by effectivedate desc`
            )?.[0]?.exchangerate || 1
        } catch (e) {
            log.error(fn, `Failed to get currency exchange rate for ${date}, ${currency}, ${txnCurrency}, ${defaultCurrency}. ${e.message}`)
        }
        // log.debug(fn, {exchangeRate})
        return exchangeRate
    }

    function formatDate(options) {
        const fn = `${scriptName}.formatDate`
        const date = new Date('1/1/1900')
        if (typeof options === 'string') {
            const settings = config.load({type:config.Type.COMPANY_PREFERENCES})
            const userSettings = config.load({type:config.Type.USER_PREFERENCES})
            const companyDatePreference = settings.getValue({fieldId:'DATEFORMAT'})
            const userDatePreference = userSettings.getValue({fieldId:'DATEFORMAT'})
            try {
                const dt = formatDate({[userDatePreference]:options})
                if (options.includes(String(dt?.getFullYear()))) {
                    return dt
                } else {
                    const dt = formatDate({[companyDatePreference]:options})
                    if (options.includes(String(dt?.getFullYear()))) {
                        return dt
                    } else {
                        throw new Error(`${fn}: Invalid date format: ${options}`)
                    }
                }
            } catch(err) {
                throw new Error(`${fn}: Invalid date format: ${options}. ${err.message}`)
            }
        }
        if (options.yymmdd) {
            date.setFullYear(`20${options.yymmdd.substring(0,2)}`)
            date.setMonth(parseInt(options.yymmdd.substring(2,4))-1)
            date.setDate(options.yymmdd.substring(4))
        } else if (options.yyyymmdd) {
            date.setFullYear(options.yyyymmdd.substring(0,4))
            date.setMonth(parseInt(options.yyyymmdd.substring(4,6))-1)
            date.setDate(options.yyyymmdd.substring(6))
        } else if (options.mmddyyyy) {
            date.setFullYear(options.mmddyyyy.split('/')[2])
            date.setMonth(parseInt(options.mmddyyyy.split('/')[0])-1)
            date.setDate(options.mmddyyyy.split('/')[1])
        } else if (options.mmddyy) {
            date.setFullYear(`20${options.mmddyy.substring(4)}`)
            date.setMonth(parseInt(options.mmddyy.substring(2,4))-1)
            date.setDate(options.mmddyy.substring(0,2))
        } else if (options["D/M/YYYY"] || options["DD/MM/YYYY"]) {
            const opt = options["D/M/YYYY"] || options["DD/MM/YYYY"]
            date.setFullYear(opt.split('/')[2])
            date.setDate(opt.split('/')[0])
            date.setMonth(parseInt(opt.split('/')[1])-1)
        } else if (options["M/D/YYYY"] || options["MM/DD/YYYY"]) {
            const opt = options["M/D/YYYY"] || options["MM/DD/YYYY"]
            date.setFullYear(opt.split('/')[2])
            date.setDate(opt.split('/')[1])
            date.setMonth(parseInt(opt.split('/')[0])-1)
        } else if (options["YYYY/MM/DD"] || options["YYYY-MM-DD"] || options["YYYY/M/D"] || options["YYYY-M-D"]) {
            const opt = options["YYYY/MM/DD"] || options["YYYY-MM-DD"] || options["YYYY/M/D"] || options["YYYY-M-D"]
            const delim = opt.includes('/') ? '/' : '-'
            date.setFullYear(opt.split(delim)[0])
            date.setDate(opt.split(delim)[2])
            date.setMonth(parseInt(opt.split(delim)[1])-1)
        } else if (options["D.M.YYYY"] || options["DD.MM.YYYY"]) {
            const opt = options["D.M.YYYY"] || options["DD.MM.YYYY"]
            date.setFullYear(opt.split('.')[2])
            date.setDate(opt.split('.')[0])
            date.setMonth(parseInt(opt.split('.')[1])-1)
        } else if (options["D-MONTH-YYYY"] || options["DD-MONTH-YYYY"]) {
            const opt = options["D-MONTH-YYYY"] || options["DD-MONTH-YYYY"]
            date.setFullYear(opt.split('-')[2])
            date.setDate(opt.split('-')[0])
            const months = ['january','february','march','april','may','june','july','august','september','october','november','december']
            const month = months.indexOf(opt.split('-')[1].toLowerCase())
            if (month > -1)
                date.setMonth(month)
        } else if (options["D MONTH, YYYY"] || options["DD MONTH, YYYY"]) {
            const opt = options["D MONTH, YYYY"] || options["DD MONTH, YYYY"]
            date.setFullYear(opt.split(', ')[1])
            date.setDate(opt.split(' ')[0])
            const months = ['january','february','march','april','may','june','july','august','september','october','november','december']
            const month = months.indexOf(opt.split(' ')[1].split(',')[0].toLowerCase())
            if (month > -1)
                date.setMonth(month)
        } else if (options["D-Mon-YYYY"] || options["DD-Mon-YYYY"]) {
            const opt = options["D-Mon-YYYY"] || options["DD-Mon-YYYY"]
            date.setFullYear(opt.split('-')[2])
            date.setDate(opt.split('-')[0])
            const months = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec']
            const month = months.indexOf(opt.split('-')[1].toLowerCase())
            if (month > -1)
                date.setMonth(month)
        }
        if (date.getFullYear() > 1900) {
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        }
        log.debug(fn, {options, date})
        if (date.getFullYear() > 1900) {
            return date
        }
        return null
    }

    function formatDate_0(options) {
        const fn = `${scriptName}.formatDate`
        log.debug(fn, {options})
        const date = new Date()
        if (options.yymmdd) {
            date.setFullYear(`20${options.yymmdd.substring(0,2)}`)
            date.setDate(options.yymmdd.substring(4))
            date.setMonth(parseInt(options.yymmdd.substring(2,4))-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        } else if (options.yyyymmdd) {
            date.setFullYear(options.yyyymmdd.substring(0,4))
            date.setDate(options.yyyymmdd.substring(6))
            date.setMonth(parseInt(options.yyyymmdd.substring(4,6))-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        } else if (options.mmddyyyy) {
            date.setFullYear(options.mmddyyyy.split('/')[2])
            date.setDate(options.mmddyyyy.split('/')[1])
            date.setMonth(parseInt(options.mmddyyyy.split('/')[0])-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        } else if (options.ddmmyy) {
            date.setFullYear(`20${options.ddmmyy.substring(4)}`)
            date.setDate(options.ddmmyy.substring(0,2))
            date.setMonth(parseInt(options.ddmmyy.substring(2,4))-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        } else if (options.mmddyy) {
            date.setFullYear(`20${options.mmddyy.substring(4)}`)
            date.setDate(options.mmddyy.substring(2,4))
            date.setMonth(parseInt(options.mmddyy.substring(0,2))-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        } else if (options["D/M/YYYY"]) {
            date.setFullYear(options["D/M/YYYY"].split('/')[2])
            date.setDate(options["D/M/YYYY"].split('/')[0])
            date.setMonth(parseInt(options["D/M/YYYY"].split('/')[1])-1)
            date.setHours(0)
            date.setMinutes(0)
            date.setSeconds(0)
            date.setMilliseconds(0)
        }
        return date
    }

    function runQuery(query) {
        return suiteQL.runSuiteQL({query}).asMappedResults()
    }

    //#endregion Misc methods
    /* ====================================================================================================== */

    return {
        // Enums
        BATCH_STATUS,
        MATCH_STATUS,
        MATCH_ISSUE,

        // RIEM Parser Endpoints
        getCashAppBatches,
        createCashAppBatch,

        // Batch Processor Endpoints
        setBatchImportInProgress,
        getCashAppTransactions,
        createCashAppTransaction,
        setCashAppBatchControlTotals,

        // Transaction Match Endpoints
        triggerTransactionMatcher,
        matchCashAppTransaction,
        autoApplyCashAppTransaction,
        setBatchImportProcessed,
        serializeTransactionData,

        // Apply Transaction Suitelet endpoints
        writeOffOverpayment,
        moveBalanceToCustomer,
        moveBalanceToCustomerDeposit,
        cashSalePrepayment,

        // Plugin callback methods
        createCashAppMatchingRule,
        createCashAppBackupMatchingRule,
        getCashAppMatchingRulesByCustomer,

        // Batch Transaction User Event Endpoints
        sortMatchedTransactions,
        queryMatchedTransactionData,
        queryPaymentsAndWriteOffs,
        lookupCashAppSetupByBatch,
        changeCashAppTransactionCustomer,
        applyCashAppTransaction,
        getCashAppMatchingIssues,
        getCashAppMatchingStatus,
        getCurrencyExchangeRate,

        // Payment Update endpoints
        queryCashAppPayments,
        syncPaymentChange,
        writeOffOverpayment,
        writeOff,

        // Backup Records
        BACKUP_STATUS,
        matchBackupRecord,
        triggerBackupParser,
        processBackupRecord,
        getBackupAttachmentRows,
        processBackupAttachmentRow,
        queryOpenTransactionsByBackupRule,
        getTransactionMatchQueryModifierForBackup,
        getBackupAIInstructions,
        processBackupRecordDataWithAI
    }
})
