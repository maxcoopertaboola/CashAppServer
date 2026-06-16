/**
 * utils/projectUtils.js
 * Utility functions for folder operations.
 */

define(['N/log', 'N/search'], function(log, search) {
    /**
     * Gets the folder ID for a given root folder path.
     * @param {string} folderPath - The root folder path (e.g., "/billsOCR").
     * @returns {number|null} - The folder ID as a number, or null if not found.
     */
    const getFolderIdByRootPath = (folderPath) => {
        // 1. Validate the input path
        if (!folderPath || !folderPath.startsWith('/')) {
            log.error({
                title: 'Invalid Folder Path',
                details: `The path must start with a forward slash (e.g., "/billsOCR"). Path provided: ${folderPath}`
            });
            return null;
        }

        const folderName = folderPath.substring(1);

        if (folderName.includes('/')) {
            log.error({
                title: 'Nested Paths Not Supported',
                details: `This function only supports direct root folders (e.g., "/FolderName"). Path provided: ${folderPath}`
            });
            return null;
        }

        if (!folderName) {
            log.error({
                title: 'Empty Folder Name',
                details: `The folder name derived from the path is empty. Path provided: ${folderPath}`
            });
            return null;
        }

        // 2. Search for the folder
        try {
            const folderSearch = search.create({
                type: search.Type.FOLDER,
                filters: [
                    ['name', search.Operator.IS, folderName],
                    'AND',
                    ['parent', search.Operator.ANYOF, '@NONE@'] // @NONE@ signifies a root-level folder
                ],
                columns: ['internalid']
            });

            // We only need to check for 0, 1, or >1 results, so fetching 2 is sufficient.
            const searchResults = folderSearch.run().getRange({ start: 0, end: 2 });

            // 3. Process the results
            if (searchResults && searchResults.length === 1) {
                const folderId = searchResults[0].id; // .id is a shortcut for the internal ID
                log.debug({
                    title: 'Target Folder Found',
                    details: `Path: ${folderPath}, Name: ${folderName}, ID: ${folderId}`
                });
                return Number(folderId); // Return ID as a number

            } else if (searchResults && searchResults.length > 1) {
                const firstFolderId = searchResults[0].id;
                log.error({
                    title: 'Multiple Root Folders Found',
                    details: `Multiple root folders with the name "${folderName}" exist. Returning the first one found: ID ${firstFolderId}.`
                });
                return Number(firstFolderId); // Mimics original logic; consider returning null for stricter behavior.

            } else {
                log.error({
                    title: 'Target Root Folder Not Found',
                    details: `No root folder found for path: ${folderPath} (Name: "${folderName}")`
                });
                return null;
            }
        } catch (e) {
            log.error({
                title: `Error searching for folder: ${folderPath}`,
                details: e // The 'e' object contains name, message, and stack trace
            });
            return null;
        }
    };

    return {
        getFolderIdByRootPath: getFolderIdByRootPath
    };
}); 