//-----------------------------------------------------------------------------------------------------------
// Copyright 2024, All rights reserved, Prolecto Resources, Inc.
//
// No part of this file may be copied or used without express, written permission of Prolecto Resources, Inc.
//-----------------------------------------------------------------------------------------------------------
// Description: User Event Script – before a Cash App Transaction record is saved, if the Customer field
//              is blank, attempt to auto-populate the Suggested Customer field by fuzzy-matching the
//              free-text customer name (custrecord_pri_cashapp_trans_cust_name) against NetSuite customers,
//              filtered by the linked subsidiary (custrecord_pri_cashapp_linked_subsidiary).
//
//              Search strategy (layered, stops at first hit):
//                1. Raw string as-is
//                2. Punctuation-cleaned string
//                3. Progressively drop trailing tokens (right→left), skipping common legal suffixes
//                4. Repeat layers 1-3 without the subsidiary constraint as a last resort
//-----------------------------------------------------------------------------------------------------------
// Version History
// 20260323 - Initial version
// 20260405 - Added amount-based fallback search when no customer name or name search yields no match
//-----------------------------------------------------------------------------------------------------------

/**
 * @NApiVersion 2.1
 * @NScriptType UserEventScript
 * @NModuleScope Public
 */
define(['N/log', 'N/search', 'N/query', '/SuiteScripts/Prolecto/Taboola Cash App/TB_CashApp_Common', './utils/matching', './config/searchMappingQuery'], function (log, search, query, cashAppCommon, matching, searchMappingQuery) {

    const MODULE = 'PRI_CashApp_UE_SuggestCustomer';

    const FIELD = {
        CUSTOMER:    'custrecord_pri_cashapp_trans_customer',
        CUST_NAME:   'custrecord_pri_cashapp_trans_cust_name',
        SUBSIDIARY:  'custrecord_pri_cashapp_linked_subsidiary',
        SUGGESTED:   'custrecord_pri_cashapp_suggested_cust',
        AMOUNT:      'custrecord_pri_cashapp_trans_amount',
        EXACT_MATCH: 'custrecord_tb_exact_match'
    };

    /**
     * Single-word tokens that are common legal-entity suffixes and carry no
     * discriminatory value when used alone in a search phrase.
     */
    const LEGAL_SUFFIX_TOKENS = new Set([
        'co', 'ltd', 'limited', 'inc', 'incorporated', 'corp', 'corporation',
        'llc', 'llp', 'lp', 'plc', 'gmbh', 'ag', 'sa', 'sas', 'bv', 'nv',
        'pte', 'pty', 'sdn', 'bhd', 'ab', 'as', 'oy', 'kk', 'pvt',
        'holding', 'holdings', 'group', 'international', 'intl'
    ]);

    // ─── Private helpers ──────────────────────────────────────────────────────

    /**
     * Strips punctuation characters and collapses whitespace.
     * e.g. "Audience IQ Asia Co.,Ltd." → "Audience IQ Asia Co Ltd"
     * @param {string} str
     * @returns {string}
     */
    function cleanString(str) {
        return str
            .replace(/[.,/#!$%^&*;:{}=\-_`~()[\]"'\\|<>?@+]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
    }

    /**
     * Splits a cleaned string into meaningful tokens, excluding standalone
     * legal-suffix words.
     * @param {string} cleaned
     * @returns {string[]}
     */
    function meaningfulTokens(cleaned) {
        return cleaned
            .split(' ')
            .filter(t => t.length > 1 && !LEGAL_SUFFIX_TOKENS.has(t.toLowerCase()));
    }

    /**
     * Runs a single N/search against the Customer record type.
     * Returns the internal ID of the first result, or null.
     *
     * @param {string}      term         - Search phrase (used with CONTAINS on entityid/altname).
     * @param {string|null} subsidiaryId - If provided, adds a subsidiary filter.
     * @returns {string|null}
     */
    function runSearch(term, subsidiaryId) {
        const fn = `${MODULE}.runSearch`;

        const trimmed = (term || '').trim();
        if (trimmed.length < 2) return null;

        try {
            const nameFilters = [
                ['altname', search.Operator.CONTAINS, trimmed],
                'OR',
                ['entityid', search.Operator.CONTAINS, trimmed]
            ];

            const filters = [
                nameFilters,
                'AND',
                ['isinactive', search.Operator.IS, 'F']
            ];

            if (subsidiaryId) {
                const withSubsidiary = [
                    filters,
                    'AND',
                    ['subsidiary', search.Operator.ANYOF, [subsidiaryId]]
                ];

                const s = search.create({
                    type:    search.Type.CUSTOMER,
                    filters: withSubsidiary,
                    columns: [search.createColumn({ name: 'entityid' })]
                });

                const results = s.run().getRange({ start: 0, end: 1 });
                if (results && results.length > 0) {
                    log.debug(fn, `Hit (subsidiary=${subsidiaryId}): "${trimmed}" → id=${results[0].id}`);
                    return results[0].id;
                }
            } else {
                const s = search.create({
                    type:    search.Type.CUSTOMER,
                    filters: filters,
                    columns: [search.createColumn({ name: 'entityid' })]
                });

                const results = s.run().getRange({ start: 0, end: 1 });
                if (results && results.length > 0) {
                    log.debug(fn, `Hit (no subsidiary): "${trimmed}" → id=${results[0].id}`);
                    return results[0].id;
                }
            }
        } catch (err) {
            log.error(fn, `Search error for "${trimmed}": ${err.message}`);
        }

        return null;
    }

    /**
     * Executes the layered fuzzy-match strategy against a single subsidiary scope.
     * Returns the first customer ID found, or null.
     *
     * Layers:
     *   1. Raw string
     *   2. Punctuation-cleaned string
     *   3. Progressively drop trailing meaningful tokens (right → left, min 1 token)
     *
     * @param {string}      rawName
     * @param {string|null} subsidiaryId
     * @returns {string|null}
     */
    function searchWithLayers(rawName, subsidiaryId) {
        const fn = `${MODULE}.searchWithLayers`;

        // Layer 1 – raw
        let match = runSearch(rawName, subsidiaryId);
        if (match) return match;

        // Layer 2 – punctuation stripped
        const cleaned = cleanString(rawName);
        if (cleaned !== rawName) {
            match = runSearch(cleaned, subsidiaryId);
            if (match) return match;
        }

        // Layer 3 – progressive token reduction (right → left)
        const tokens = meaningfulTokens(cleaned);
        log.debug(fn, `Meaningful tokens: [${tokens.join(', ')}]`);

        for (let count = tokens.length - 1; count >= 1; count--) {
            const partial = tokens.slice(0, count).join(' ');
            log.debug(fn, `Trying partial (${count} tokens): "${partial}"`);
            match = runSearch(partial, subsidiaryId);
            if (match) return match;
        }

        return null;
    }

    /**
     * Master entry point for finding the best-matching customer.
     * First tries with the subsidiary constraint, then without as a fallback.
     *
     * @param {string}      rawName
     * @param {string|null} subsidiaryId
     * @returns {string|null}
     */
    function findBestMatchingCustomer(rawName, subsidiaryId) {
        const fn = `${MODULE}.findBestMatchingCustomer`;

        if (!rawName) return null;

        log.debug(fn, `Starting match for: "${rawName}", subsidiary=${subsidiaryId}`);

        // Primary pass – with subsidiary filter
        let match = searchWithLayers(rawName, subsidiaryId);
        if (match) return match;

        // Fallback pass – ignore subsidiary restriction
        if (subsidiaryId) {
            log.debug(fn, 'No subsidiary-scoped match; retrying without subsidiary filter.');
            match = searchWithLayers(rawName, null);
            if (match) return match;
        }

        log.debug(fn, `No match found for "${rawName}"`);
        return null;
    }

    /**
     * Searches open invoices by the given payment amount and returns the customer ID
     * only when all matching invoices belong to a single unique customer.
     * Returns null if no invoices are found or results are ambiguous (multiple customers).
     *
     * @param {number}      amount
     * @param {string|null} subsidiaryId
     * @returns {string|null}
     */
    function findCustomerByAmount(amount, subsidiaryId) {
        const fn = `${MODULE}.findCustomerByAmount`;

        log.debug(fn, `Searching invoices by amount=${amount}, subsidiary=${subsidiaryId}`);

        try {
            const invoices = cashAppCommon.queryInvoicesByAmount(amount, subsidiaryId);

            if (!invoices || invoices.length === 0) {
                log.debug(fn, `No invoices found for amount=${amount}`);
                return null;
            }

            const uniqueCustomerIds = [...new Set(invoices.map(inv => String(inv.entity)))];

            if (uniqueCustomerIds.length === 1) {
                log.debug(fn, `Single customer match by amount: entity=${uniqueCustomerIds[0]}, invoiceCount=${invoices.length}`);
                return uniqueCustomerIds[0];
            }

            log.debug(fn, `Ambiguous amount match: ${uniqueCustomerIds.length} different customers – skipping.`);
            return null;
        } catch (err) {
            log.error(fn, `Amount search error: ${err.message}`);
            return null;
        }
    }

    /**
     * Queries open invoices for the given customer, runs the subset-sum matching
     * algorithm, and sets the Exact Match flag on the record when a match is found.
     *
     * @param {Record} rec        - The current record being saved.
     * @param {string} customerId - Internal ID of the suggested customer.
     */
    function runExactMatchCheck(rec, customerId) {
        const fn = `${MODULE}.runExactMatchCheck`;

        const amount = parseFloat(rec.getValue({ fieldId: FIELD.AMOUNT }));
        if (!amount || isNaN(amount) || amount <= 0) {
            log.debug(fn, 'No valid amount on record – skipping exact-match check.');
            return;
        }

        try {
            const queryConfig = searchMappingQuery.getMappingQuery('open_invoices_by_customer', customerId);
            const resultSet   = query.runSuiteQL({ query: queryConfig.query, params: queryConfig.params });
            const rawInvoices = resultSet.asMappedResults();

            if (!rawInvoices || rawInvoices.length === 0) {
                log.debug(fn, `No open invoices found for customer ${customerId}.`);
                return;
            }

            log.debug(fn, `Found ${rawInvoices.length} open invoice(s) for customer ${customerId}.`);

            const invoices = rawInvoices.map(function (inv) {
                return {
                    invoice_id:             inv.invoice_id,
                    invoice_date:           inv.invoice_date,
                    invoice_number:         inv.invoice_number,
                    invoice_currency:       inv.invoice_currency,
                    invoice_total:          parseFloat(inv.invoice_total)          || 0,
                    invoice_unpaid_balance: parseFloat(inv.invoice_unpaid_balance) || 0
                };
            });

            const result = matching.matchInvoicesToTransactions([{
                cash_app_transaction_amount: amount,
                invoices:                    invoices
            }]);

            if (result && result[0] && result[0].cash_app_transaction_match_status === 'Exact Match') {
                rec.setValue({ fieldId: FIELD.EXACT_MATCH, value: true });
                log.audit(fn, `Exact match found for customer ${customerId}, amount=${amount} – exact match flag set.`);
            } else {
                log.debug(fn, `No exact invoice match for customer ${customerId}, amount=${amount}.`);
            }
        } catch (err) {
            log.error(fn, `Exact match check failed: ${err.message}`);
        }
    }

    // ─── Entry point ─────────────────────────────────────────────────────────

    /**
     * @param {Object} context
     * @param {Record} context.newRecord
     * @param {string} context.type
     */
    function beforeSubmit(context) {
        const fn = `${MODULE}.beforeSubmit`;

        if (context.type === context.UserEventType.DELETE) return;

        const rec = context.newRecord;

        const customer = rec.getValue({ fieldId: FIELD.CUSTOMER });
        if (customer) {
            log.debug(fn, `Customer already populated (${customer}) – skipping suggestion.`);
            return;
        }

        const alreadySuggested = rec.getValue({ fieldId: FIELD.SUGGESTED });
        if (alreadySuggested) {
            log.debug(fn, `Suggested customer already populated (${alreadySuggested}) – skipping suggestion.`);
            return;
        }

        const custName     = rec.getValue({ fieldId: FIELD.CUST_NAME });
        const subsidiaryId = rec.getValue({ fieldId: FIELD.SUBSIDIARY }) || null;

        let suggestedId = null;

        // ── Layer A: name-based fuzzy match ──────────────────────────────────
        if (custName) {
            suggestedId = findBestMatchingCustomer(String(custName).trim(), subsidiaryId);
            if (!suggestedId) {
                log.debug(fn, `Name-based match failed for "${custName}" – falling back to amount search.`);
            }
        } else {
            log.debug(fn, 'No customer name value – skipping name search, attempting amount-based search.');
        }

        // ── Layer B: amount-based fallback ───────────────────────────────────
        if (!suggestedId) {
            const amount = parseFloat(rec.getValue({ fieldId: FIELD.AMOUNT }));
            if (amount && !isNaN(amount)) {
                suggestedId = findCustomerByAmount(amount, subsidiaryId);
            } else {
                log.debug(fn, 'No valid amount value – cannot perform amount-based search.');
            }
        }

        if (suggestedId) {
            rec.setValue({ fieldId: FIELD.SUGGESTED, value: suggestedId });
            log.audit(fn, `Suggested customer set → id=${suggestedId} for name="${custName || '(none)'}"`);

            runExactMatchCheck(rec, suggestedId);
        } else {
            log.debug(fn, `No suggestion for "${custName || '(none)'}" – leaving field empty.`);
        }
    }

    return {
        beforeSubmit: beforeSubmit
    };
});
