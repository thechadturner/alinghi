const { PERMISSIONS, ACCESS_TYPES } = require('./constants');

/**
 * Permission checking utilities
 */

/**
 * Check if a permission level allows a specific access type
 * @param {string} permission - Permission level
 * @param {string} accessType - Access type
 * @returns {boolean} Permission status
 */
function hasAccess(permission, accessType) {
  switch (accessType) {
    case ACCESS_TYPES.READ:
      return true; // All users with project access can read
      
    case ACCESS_TYPES.WRITE:
      return [
        PERMISSIONS.SUPERUSER,
        PERMISSIONS.ADMINISTRATOR,
        PERMISSIONS.PUBLISHER,
        PERMISSIONS.CONTRIBUTOR
      ].includes(permission);
      
    case ACCESS_TYPES.DELETE:
      return [
        PERMISSIONS.SUPERUSER,
        PERMISSIONS.ADMINISTRATOR
      ].includes(permission);
      
    case ACCESS_TYPES.ADMIN:
      return [
        PERMISSIONS.SUPERUSER,
        PERMISSIONS.ADMINISTRATOR
      ].includes(permission);
      
    default:
      return false;
  }
}

/**
 * Get permission hierarchy level (higher number = more permissions)
 * @param {string} permission - Permission level
 * @returns {number} Hierarchy level
 */
function getPermissionLevel(permission) {
  const levels = {
    [PERMISSIONS.READER]: 1,
    [PERMISSIONS.CONTRIBUTOR]: 2,
    [PERMISSIONS.PUBLISHER]: 3,
    [PERMISSIONS.ADMINISTRATOR]: 4,
    [PERMISSIONS.SUPERUSER]: 5
  };
  
  return levels[permission] || 0;
}

/**
 * Check if one permission level is higher than another
 * @param {string} permission1 - First permission
 * @param {string} permission2 - Second permission
 * @returns {boolean} True if permission1 is higher than permission2
 */
function isHigherPermission(permission1, permission2) {
  return getPermissionLevel(permission1) > getPermissionLevel(permission2);
}

/**
 * Get all permission levels that allow a specific access type
 * @param {string} accessType - Access type
 * @returns {Array} Array of permission levels
 */
function getPermissionsForAccess(accessType) {
  switch (accessType) {
    case ACCESS_TYPES.READ:
      return Object.values(PERMISSIONS);
      
    case ACCESS_TYPES.WRITE:
      return [
        PERMISSIONS.SUPERUSER,
        PERMISSIONS.ADMINISTRATOR,
        PERMISSIONS.PUBLISHER,
        PERMISSIONS.CONTRIBUTOR
      ];
      
    case ACCESS_TYPES.DELETE:
      return [
        PERMISSIONS.SUPERUSER,
        PERMISSIONS.ADMINISTRATOR
      ];
      
    case ACCESS_TYPES.ADMIN:
      return [
        PERMISSIONS.SUPERUSER,
        PERMISSIONS.ADMINISTRATOR
      ];
      
    default:
      return [];
  }
}

/**
 * Validate permission level
 * @param {string} permission - Permission level to validate
 * @returns {boolean} True if valid permission
 */
function isValidPermission(permission) {
  return Object.values(PERMISSIONS).includes(permission);
}

/**
 * Validate access type
 * @param {string} accessType - Access type to validate
 * @returns {boolean} True if valid access type
 */
function isValidAccessType(accessType) {
  return Object.values(ACCESS_TYPES).includes(accessType);
}

/**
 * Get permission display name
 * @param {string} permission - Permission level
 * @returns {string} Display name
 */
function getPermissionDisplayName(permission) {
  const names = {
    [PERMISSIONS.SUPERUSER]: 'Super User',
    [PERMISSIONS.ADMINISTRATOR]: 'Administrator',
    [PERMISSIONS.PUBLISHER]: 'Publisher',
    [PERMISSIONS.CONTRIBUTOR]: 'Contributor',
    [PERMISSIONS.READER]: 'Reader'
  };
  
  return names[permission] || 'Unknown';
}

/**
 * Get access type display name
 * @param {string} accessType - Access type
 * @returns {string} Display name
 */
function getAccessTypeDisplayName(accessType) {
  const names = {
    [ACCESS_TYPES.READ]: 'Read',
    [ACCESS_TYPES.WRITE]: 'Write',
    [ACCESS_TYPES.DELETE]: 'Delete',
    [ACCESS_TYPES.ADMIN]: 'Admin'
  };
  
  return names[accessType] || 'Unknown';
}

module.exports = {
  hasAccess,
  getPermissionLevel,
  isHigherPermission,
  getPermissionsForAccess,
  isValidPermission,
  isValidAccessType,
  getPermissionDisplayName,
  getAccessTypeDisplayName
};
