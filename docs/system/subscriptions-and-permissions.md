# Subscriptions and Permissions Documentation

## Overview
RaceSight implements a comprehensive subscription and permission system that controls user access to features and data based on their subscription plan and role within projects.

## Subscription System

### Subscription Types
Subscriptions are managed through the `userStore` and can be either:
- **String-based**: Simple plan identifier (e.g., "basic", "premium", "enterprise")
- **Object-based**: Detailed subscription information with features and dates

### Subscription Interface
```typescript
interface Subscription {
  id?: number;
  plan?: string;
  status?: string;
  startDate?: string;
  endDate?: string;
  features?: string[];
  [key: string]: any;
}
```

### Subscription Management
- **Fetching**: Subscriptions are fetched via `/api/users/subscription` during auth handshake
- **Storage**: Stored in `userStore` as `subscription` signal
- **Access**: Available throughout the application via `subscription()` signal

### Subscription States
- **Active**: User has valid, non-expired subscription
- **Expired**: Subscription has passed end date
- **Cancelled**: Subscription has been cancelled
- **Pending**: Subscription is awaiting activation

## Permission System

### Permission Levels
The system implements a hierarchical permission structure:

1. **SUPERUSER** (Level 5)
   - Full system access
   - Can perform all operations
   - Can manage all users and projects

2. **ADMINISTRATOR** (Level 4)
   - Project-level administrative access
   - Can manage users within projects
   - Can delete data and manage project settings

3. **PUBLISHER** (Level 3)
   - Can create and modify content
   - Can publish reports and datasets
   - Cannot delete or manage users

4. **CONTRIBUTOR** (Level 2)
   - Can create and modify content
   - Limited publishing capabilities
   - Cannot manage other users

5. **READER** (Level 1)
   - Read-only access
   - Can view data and reports
   - Cannot create or modify content

### Access Types
Permissions are checked against specific access types:

- **READ**: View data, reports, and content
- **WRITE**: Create and modify content
- **DELETE**: Remove data and content
- **ADMIN**: Administrative operations and user management

### Permission Checking
```javascript
// Check if user has specific access
hasAccess(permission, accessType)

// Examples:
hasAccess('administrator', 'write') // true
hasAccess('reader', 'delete') // false
hasAccess('superuser', 'admin') // true
```

### Permission Hierarchy
```javascript
// Compare permission levels
isHigherPermission('administrator', 'contributor') // true
getPermissionLevel('publisher') // 3
```

## User Store Integration

### User Interface
```typescript
interface User {
  id: number;
  username: string;
  email: string;
  firstName?: string;
  lastName?: string;
  role?: string;
  permissions?: string[];
  [key: string]: any;
}
```

### Store Signals
- `isLoggedIn`: Boolean indicating authentication status
- `user`: Current user object with profile information
- `subscription`: Current subscription data
- `isAccepted`: Terms of service acceptance status
- `isCookiePolicy`: Cookie policy acceptance status

## Project-Level Permissions

### Project Access Control
Users can have different permission levels for different projects:
- A user might be an administrator for Project A
- The same user might be a reader for Project B
- Permissions are checked per-project, not globally

### Permission Inheritance
- Project permissions inherit from user's base role
- Project-specific permissions can override base permissions
- Higher-level permissions include all lower-level capabilities

## Feature Access Control

### Subscription-Based Features
Certain features are only available to users with specific subscription plans:
- **Basic Plan**: Limited data storage and basic reports
- **Premium Plan**: Advanced analytics and extended storage
- **Enterprise Plan**: Full feature access and custom integrations

### Permission-Based Features
Features are also controlled by user permissions:
- **Data Upload**: Requires WRITE permission
- **User Management**: Requires ADMIN permission
- **Data Deletion**: Requires DELETE permission
- **Report Publishing**: Requires PUBLISHER or higher

## Implementation Details

### Authentication Flow
1. User logs in via `/api/auth/login`
2. JWT tokens are issued with user and permission data
3. Subscription data is fetched via `/api/users/subscription`
4. User store is populated with all authentication data
5. Permission checks are performed throughout the application

### Permission Middleware
Server-side permission checking is handled by middleware:
- `auth_jwt.js`: Validates JWT tokens and extracts user data
- `permissions.js`: Checks specific permissions for API endpoints
- Project-specific permission validation in route handlers

### Frontend Permission Checks
```javascript
// Check if user can perform specific actions
const canWrite = hasAccess(user().permissions, 'write');
const canDelete = hasAccess(user().permissions, 'delete');
const canAdmin = hasAccess(user().permissions, 'admin');
```

## Security Considerations

### Token Management
- **Access Tokens**: Short-lived (4 hours) for API requests
- **Refresh Tokens**: Longer-lived (7 days) for token renewal
- **System Tokens**: Long-lived (1 year) for system operations

### Permission Validation
- All API endpoints validate permissions server-side
- Frontend permission checks are for UI/UX only
- Server-side validation is the source of truth

### Data Isolation
- Users can only access data from projects they have permission for
- Project-level data isolation prevents cross-project data leakage
- Permission inheritance ensures consistent access patterns

## Debugging and Monitoring

### Permission Debugging
```javascript
// Get current user permissions
console.log('User permissions:', user().permissions);

// Check specific permission
console.log('Can write:', hasAccess(user().permissions, 'write'));

// Get permission level
console.log('Permission level:', getPermissionLevel(user().permissions));
```

### Subscription Debugging
```javascript
// Get current subscription
console.log('Subscription:', subscription());

// Check subscription status
if (subscription() && subscription().status) {
  console.log('Subscription status:', subscription().status);
}
```

## Best Practices

### Permission Checking
1. Always check permissions server-side for security
2. Use frontend checks only for UI/UX improvements
3. Implement proper error handling for permission failures
4. Log permission-related actions for audit trails

### Subscription Management
1. Validate subscription status before granting access to features
2. Implement graceful degradation for expired subscriptions
3. Provide clear messaging about subscription limitations
4. Handle subscription changes reactively

### User Experience
1. Hide unavailable features rather than showing error messages
2. Provide clear upgrade paths for restricted features
3. Show current permission level and subscription status
4. Implement proper loading states during permission checks

## API Endpoints

### Authentication
- `POST /api/auth/login` - User login
- `POST /api/auth/refresh` - Token refresh
- `POST /api/auth/logout` - User logout

### User Management
- `GET /api/users/subscription` - Get user subscription
- `PUT /api/users/subscription` - Update subscription
- `GET /api/users/profile` - Get user profile

### Permission Checking
- `GET /api/users/permissions` - Get user permissions
- `POST /api/users/check-permission` - Check specific permission
