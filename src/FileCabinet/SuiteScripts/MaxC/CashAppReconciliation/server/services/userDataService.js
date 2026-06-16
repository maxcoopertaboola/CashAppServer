/**
 * services/userDataService.js
 * Service layer for User Data operations.
 */

define(['N/runtime', 'N/log', 'N/record', 'N/query'], (runtime, log, record, query) => {
    return {
        /**
         * Gets current user data including name, email, role, and accessible subsidiaries.
         * @returns {Object} - The current user data object.
         */
        getCurrentUserData: function() {
            try {
                // Get current user information
                const currentUser = runtime.getCurrentUser();
                
                // Get basic user info
                const userData = {
                    id: currentUser.id,
                    name: currentUser.name,
                    email: currentUser.email,
                    roleId: currentUser.role,
                    subsidiaries: [],
                    preferences: {}
                };

                // Get role data using SuiteQL
                try {
                    const roleData = this.getRoleData(currentUser.role);
                    userData.roleName = roleData.name || 'Unknown';
                    userData.roleSubsidiaryOption = roleData.subsidiaryOption;
                    userData.roleSubsidiaryRestriction = roleData.subsidiaryRestriction;
                    userData.roleSubsidiaryRestrictionName = roleData.subsidiaryRestrictionName;
                } catch (roleError) {
                    log.error('Error getting role data', roleError);
                    userData.roleName = 'Unknown';
                    userData.roleSubsidiaryOption = null;
                    userData.roleSubsidiaryRestriction = null;
                    userData.roleSubsidiaryRestrictionName = null;
                }

                // Get user preferences
                try {
                    userData.preferences = this.getUserPreferences(currentUser);
                } catch (prefError) {
                    log.error('Error getting user preferences', prefError);
                    userData.preferences = {};
                }

                // Set subsidiaries based on role data
                if (userData.roleSubsidiaryOption === 'ALL') {
                    userData.subsidiaries = ''; // Empty string for ALL access
                } else {
                    userData.subsidiaries = userData.roleSubsidiaryRestriction || ''; // Comma-separated IDs
                }

                log.debug('User Data Retrieved', `User ID: ${userData.id}, Role: ${userData.roleName}`);

                return {
                    success: true,
                    data: userData
                };

            } catch (error) {
                log.error('Error in getCurrentUserData', error);
                throw error;
            }
        },

        /**
         * Gets role data using SuiteQL.
         * @param {string} roleId - The role ID to get data for.
         * @returns {Object} - Role data object containing name, subsidiaryOption, and subsidiaryRestriction.
         */
        getRoleData: function(roleId) {
            try {
                log.debug('Getting role data for role ID', roleId);
                const sqlQuery = `
                        SELECT name, 
                            subsidiaryOption,
                                subsidiaryRestriction,
                            BUILTIN.DF(subsidiaryRestriction) AS subsidiaryRestrictionName
                        FROM role
                    WHERE id = ?
                `;

                const results = query.runSuiteQL({
                    query: sqlQuery,
                    params: [roleId]
                }).asMappedResults();

                if (results.length === 0) {
                    throw new Error(`Role with ID ${roleId} not found`);
                }

                const roleData = results[0];
                log.debug('Role Data Retrieved', roleData);

                return {
                    name: roleData.name,
                    subsidiaryOption: roleData.subsidiaryoption,
                    subsidiaryRestriction: roleData.subsidiaryrestriction,
                    subsidiaryRestrictionName: roleData.subsidiaryrestrictionname
                };

            } catch (error) {
                log.error('Error in getRoleData', error);
                throw error;
            }
        },

        /**
         * Gets user preferences using User.getPreference(options).
         * @param {Object} currentUser - The current user object from runtime.getCurrentUser().
         * @returns {Object} - User preferences object containing date format and other preferences.
         */
        getUserPreferences: function(currentUser) {
            try {
                log.debug('Getting user preferences for user ID', currentUser.id);
                
                const preferences = {};

                // Get DATEFORMAT preference from General Preferences
                try {
                    preferences.dateFormat = currentUser.getPreference({
                        name: 'DATEFORMAT'
                    });
                    log.debug('Date Format Retrieved', preferences.dateFormat);
                } catch (dateFormatError) {
                    log.error('Error getting DATEFORMAT preference', dateFormatError);
                    preferences.dateFormat = null;
                }

                log.debug('User Preferences Retrieved', preferences);

                return preferences;

            } catch (error) {
                log.error('Error in getUserPreferences', error);
                throw error;
            }
        }
    };
}); 