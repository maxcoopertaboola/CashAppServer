/**
 * File Cabinet CSV Financial Institution Connectivity Plug-in
 *
 * Reads CSV files from File Cabinet folder 8053998 and sends them to the
 * selected Transaction Parser on the Bank Reconciliation Format Profile.
 *
 * @NApiVersion 2.x
 * @NScriptType fiConnectivityPlugin
 * @NModuleScope SameAccount
 */
define(['N/file', 'N/search', 'N/error', 'N/log'], function (file, search, error, log) {

    var SOURCE_FOLDER_ID = 7650733;

    /*
     * Optional but strongly recommended for production:
     * 1. Create a separate File Cabinet folder, for example "Bank Feed Processed".
     * 2. Put its internal ID here.
     * 3. Set MOVE_TO_PROCESSED_FOLDER to true after testing.
     *
     * Important: this moves files after the plug-in sends them to NetSuite,
     * not after final parser success. For stricter production control, use
     * a custom "bank feed file import log" record instead.
     */
    var MOVE_TO_PROCESSED_FOLDER = true;
    var PROCESSED_FOLDER_ID = 7627537;

    /*
     * This must match the CSV header mapped as "Account Number"
     * in the CSV parser configuration.
     */
    var ACCOUNT_NUMBER_HEADER = 'Account Number';

    /*
     * Keep chunks well below NetSuite's 25-million-character addDataChunk limit.
     */
    var MAX_CHUNK_CHARS = 9000000;

    /*
     * Replace this with your real bank/account identifiers.
     *
     * accountMappingKey must match the value in the CSV Account Number column.
     * currency must match the currency of the NetSuite GL account you will link.
     */
    var ACCOUNTS = [
        {
            accountMappingKey: '111164',
            displayName: 'TIT - Citi EUR 132745072',
            accountType: 'BANK',
            currency: 'EUR',
            groupName: 'File Cabinet CSV Bank Feed'
        }
    ];

    function getConfigurationIFrameUrl(context) {
        /*
         * No configuration page is used in this simple version.
         * Folder/account setup is hard-coded above.
         */
    }

    function getAccounts(context) {
        validateAccounts();

        for (var i = 0; i < ACCOUNTS.length; i++) {
            context.addAccount({
                accountMappingKey: ACCOUNTS[i].accountMappingKey,
                displayName: ACCOUNTS[i].displayName,
                accountType: ACCOUNTS[i].accountType,
                currency: ACCOUNTS[i].currency,
                groupName: ACCOUNTS[i].groupName
            });
        }
    }

    function getTransactionData(context) {
        validateAccounts();

        var requestInfo = buildRequestedAccountMap(context.accountRequestsJSON);
        var csvFiles = findCsvFiles();

        log.audit({
            title: 'File Cabinet Bank Feed Import Started',
            details: 'Folder: ' + SOURCE_FOLDER_ID + ', CSV files found: ' + csvFiles.length
        });

        var state = {
            headerLine: null,
            normalizedHeader: null,
            headerWritten: false,
            buffer: '',
            rowCount: 0,
            filesWithIncludedRows: []
        };

        for (var i = 0; i < csvFiles.length; i++) {
            var includedRows = processCsvFile(context, csvFiles[i], requestInfo, state);

            if (includedRows > 0) {
                state.filesWithIncludedRows.push(csvFiles[i]);
            }
        }

        flushChunk(context, state);

        /*
         * For Bank Reconciliation profiles, return the queried account requests.
         */
        context.returnAccountRequestsJSON({
            accountsJson: context.accountRequestsJSON
        });

        log.audit({
            title: 'File Cabinet Bank Feed Import Finished',
            details: 'Rows sent: ' + state.rowCount +
                ', files with matching rows: ' + state.filesWithIncludedRows.length
        });

        if (MOVE_TO_PROCESSED_FOLDER && PROCESSED_FOLDER_ID) {
            moveProcessedFiles(state.filesWithIncludedRows);
        }
    }

    function validateAccounts() {
        if (!ACCOUNTS || ACCOUNTS.length === 0) {
            throw error.create({
                name: 'BANKFEED_NO_ACCOUNTS',
                message: 'No accounts are configured in the ACCOUNTS array.'
            });
        }

        for (var i = 0; i < ACCOUNTS.length; i++) {
            if (!ACCOUNTS[i].accountMappingKey ||
                ACCOUNTS[i].accountMappingKey === 'CHANGE_ME_ACCOUNT_NUMBER_FROM_CSV') {
                throw error.create({
                    name: 'BANKFEED_ACCOUNT_NOT_CONFIGURED',
                    message: 'Replace CHANGE_ME_ACCOUNT_NUMBER_FROM_CSV in the ACCOUNTS array before using this plug-in.'
                });
            }
        }
    }

    function buildRequestedAccountMap(accountRequestsJSON) {
        var result = {
            hasRequests: false,
            requestedAccounts: {}
        };

        if (!accountRequestsJSON) {
            return result;
        }

        var requests = JSON.parse(accountRequestsJSON);

        for (var i = 0; i < requests.length; i++) {
            if (requests[i].accountMappingKey) {
                result.hasRequests = true;
                result.requestedAccounts[trimString(requests[i].accountMappingKey)] = true;
            }
        }

        return result;
    }

    function findCsvFiles() {
        var files = [];

        var fileSearch = search.create({
            type: 'file',
            filters: [
                ['folder', 'anyof', SOURCE_FOLDER_ID]
            ],
            columns: [
                search.createColumn({ name: 'created', sort: search.Sort.ASC }),
                search.createColumn({ name: 'internalid' }),
                search.createColumn({ name: 'name' })
            ]
        });

        fileSearch.run().each(function (result) {
            var fileName = result.getValue({ name: 'name' }) || '';

            if (/\.csv$/i.test(fileName)) {
                files.push({
                    id: result.getValue({ name: 'internalid' }),
                    name: fileName
                });
            }

            return true;
        });

        return files;
    }

    function processCsvFile(context, fileInfo, requestInfo, state) {
        var csvFile = file.load({ id: fileInfo.id });
        var iterator = csvFile.lines.iterator();

        var headerRead = false;
        var accountColumnIndex = -1;
        var includedRows = 0;
        var fileHeaderLine = null;
        var fileNormalizedHeader = null;

        iterator.each(function (line) {
            var lineValue = line.value || '';

            if (!headerRead) {
                if (isBlank(lineValue)) {
                    return true;
                }

                fileHeaderLine = stripBom(lineValue);
                fileNormalizedHeader = normalizeHeaderLine(fileHeaderLine);
                accountColumnIndex = findAccountColumnIndex(fileHeaderLine);

                if (accountColumnIndex < 0) {
                    throw error.create({
                        name: 'BANKFEED_ACCOUNT_COLUMN_NOT_FOUND',
                        message: 'File "' + fileInfo.name + '" does not contain required CSV header "' +
                            ACCOUNT_NUMBER_HEADER + '".'
                    });
                }

                if (!state.normalizedHeader) {
                    state.headerLine = fileHeaderLine;
                    state.normalizedHeader = fileNormalizedHeader;
                } else if (state.normalizedHeader !== fileNormalizedHeader) {
                    throw error.create({
                        name: 'BANKFEED_CSV_HEADER_MISMATCH',
                        message: 'File "' + fileInfo.name + '" has a different CSV header than the first file.'
                    });
                }

                headerRead = true;
                return true;
            }

            if (isBlank(lineValue)) {
                return true;
            }

            if (shouldIncludeRow(lineValue, accountColumnIndex, requestInfo)) {
                ensureHeaderWritten(context, state);
                addLineToChunk(context, state, lineValue);
                state.rowCount++;
                includedRows++;
            }

            return true;
        });

        log.audit({
            title: 'Processed CSV File',
            details: 'File: ' + fileInfo.name + ', matching rows included: ' + includedRows
        });

        return includedRows;
    }

    function shouldIncludeRow(lineValue, accountColumnIndex, requestInfo) {
        if (!requestInfo.hasRequests) {
            return true;
        }

        var columns = parseCsvLine(lineValue);
        var accountNumber = trimString(columns[accountColumnIndex] || '');

        return requestInfo.requestedAccounts[accountNumber] === true;
    }

    function ensureHeaderWritten(context, state) {
        if (!state.headerWritten) {
            addLineToChunk(context, state, state.headerLine);
            state.headerWritten = true;
        }
    }

    function addLineToChunk(context, state, lineValue) {
        var text = lineValue + '\n';

        if (state.buffer.length + text.length > MAX_CHUNK_CHARS) {
            flushChunk(context, state);
        }

        state.buffer += text;
    }

    function flushChunk(context, state) {
        if (state.buffer && state.buffer.length > 0) {
            context.addDataChunk({
                dataChunk: state.buffer
            });

            state.buffer = '';
        }
    }

    function moveProcessedFiles(filesWithIncludedRows) {
        for (var i = 0; i < filesWithIncludedRows.length; i++) {
            try {
                var f = file.load({ id: filesWithIncludedRows[i].id });
                f.folder = PROCESSED_FOLDER_ID;
                f.save();

                log.audit({
                    title: 'Moved Processed Bank Feed File',
                    details: 'Moved file "' + filesWithIncludedRows[i].name +
                        '" to folder ' + PROCESSED_FOLDER_ID
                });
            } catch (e) {
                log.error({
                    title: 'Could Not Move Processed File',
                    details: 'File "' + filesWithIncludedRows[i].name + '": ' + e.name + ' - ' + e.message
                });
            }
        }
    }

    function findAccountColumnIndex(headerLine) {
        var headers = parseCsvLine(headerLine);

        for (var i = 0; i < headers.length; i++) {
            if (normalizeHeaderName(headers[i]) === normalizeHeaderName(ACCOUNT_NUMBER_HEADER)) {
                return i;
            }
        }

        return -1;
    }

    function normalizeHeaderLine(headerLine) {
        var headers = parseCsvLine(stripBom(headerLine));
        var normalized = [];

        for (var i = 0; i < headers.length; i++) {
            normalized.push(normalizeHeaderName(headers[i]));
        }

        return normalized.join('|');
    }

    function normalizeHeaderName(value) {
        return trimString(stripBom(value || '')).toLowerCase();
    }

    function stripBom(value) {
        return String(value || '').replace(/^\uFEFF/, '');
    }

    function isBlank(value) {
        return trimString(value || '') === '';
    }

    function trimString(value) {
        return String(value || '').replace(/^\s+|\s+$/g, '');
    }

    /*
     * Minimal CSV line parser supporting quoted values and escaped quotes.
     */
    function parseCsvLine(line) {
        var values = [];
        var current = '';
        var inQuotes = false;

        for (var i = 0; i < line.length; i++) {
            var ch = line.charAt(i);

            if (ch === '"') {
                if (inQuotes && line.charAt(i + 1) === '"') {
                    current += '"';
                    i++;
                } else {
                    inQuotes = !inQuotes;
                }
            } else if (ch === ',' && !inQuotes) {
                values.push(current);
                current = '';
            } else {
                current += ch;
            }
        }

        values.push(current);
        return values;
    }

    return {
        getConfigurationIFrameUrl: getConfigurationIFrameUrl,
        getAccounts: getAccounts,
        getTransactionData: getTransactionData
    };
});