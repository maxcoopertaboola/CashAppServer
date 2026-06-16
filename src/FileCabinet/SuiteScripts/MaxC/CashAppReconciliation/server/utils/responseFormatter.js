/**
 * Utils/responseFormatter.js
 * Formats the search results into a standardized JSON structure.
 */

define([ 'N/log', './matching'], function(log, matching) {
    /**
     * Formats SuiteQL search results.
     * @param {Array<Object>} records - The SuiteQL search results.
     * @param {Array<string>} responseFields - Fields to include in the text.
     * @returns {Array<Object>} - Formatted results.
     */
    function formatSuiteQLResults(records, responseFields, isSearch) {
        const [primaryField, secondaryField] = responseFields;
        return records.length > 0 ? transformInvoices(records.map(function(record) { 
            let response = {};
            if (isSearch) {
                let text = record[primaryField];
                if (secondaryField && record[secondaryField]) {
                    text += ` - ${record[secondaryField]}`;
                }
                response.id = record.id;
                response.text = text;
                response.all = record;
            } else {
                response = record;
            }

            return response;
        })) : [];
    }

    /**
     * Formats Saved Search results.
     * @param {Array<Object>} results - The Saved Search results.
     * @param {Array<string>} responseFields - Fields to include in the text.
     * @returns {Array<Object>} - Formatted results.
     */
    function formatSavedSearchResults(results, responseFields, isSearch) {   
        try {
            return results.length > 0 ? transformInvoices(results.map(function(result) {
                let response = {};
                if (isSearch) {
                    const values = responseFields.map(function(field) {
                        return result.getValue(field);
                    }).filter(Boolean);
                    const text = values.join(' - ');
                    response.id = result.id;
                    response.text = text;
                }
                const allFields = {};
                responseFields.forEach(function(field) {
                    allFields[field.label || field.name || field] = result.getValue(field);
                });
                isSearch ? response.all = allFields : response = allFields;

                return response
            })) : [];
        } catch (error) {
            log.error('Error in formatSavedSearchResults', error);
        }
    }

    function transformInvoices(data) {
        if (data[0].hasOwnProperty('text')) { return data; }

        var lineFieldsSet = {
            invoice_id: true, invoice_date: true, invoice_number: true,
            invoice_status: true, invoice_total: true, invoice_unpaid_balance: true,
            invoice_currency_id: true, invoice_currency: true,
            invoice_entity_id: true, invoice_entity_name: true,
            tax_precentage: true, invoice_subtotal: true,
            transaction_category: true, invoice_type: true
        };
        var lineFields = Object.keys(lineFieldsSet);
        var grouped = {};
        var order = [];

        data.forEach(function(record) {
            var id = record.id;
            var details = record.cash_app_transaction_details || record.custrecord_pri_cashapp_trans_details;

            if (typeof details === 'string') {
                try { details = JSON.parse(details); } catch(e) { details = {}; }
            }

            if (!grouped[id]) {
                order.push(id);
                var transaction = {};
                Object.keys(record).forEach(function(key) {
                    if (!lineFieldsSet[key]) {
                        var isDetailsField = key === 'cash_app_transaction_details' || key === 'custrecord_pri_cashapp_trans_details';
                        transaction[key] = isDetailsField ? details : record[key];
                    }
                });
                transaction.invoices = [];
                transaction.payments = [];
                grouped[id] = transaction;
            }

            if (record.invoice_id !== '' && record.invoice_id != null) {
                var line = {};
                lineFields.forEach(function(field) {
                    if (field !== 'transaction_category') {
                        line[field] = record[field];
                    }
                });

                if (record.transaction_category === 'payments') {
                    grouped[id].payments.push(line);
                } else {
                    grouped[id].invoices.push(line);
                }
            }
        });

        var transactions = order.map(function(id) { return grouped[id]; });
        return matching.matchInvoicesToTransactions(transactions);
    }

    return {
        formatSuiteQLResults: formatSuiteQLResults,
        formatSavedSearchResults: formatSavedSearchResults
    };
});