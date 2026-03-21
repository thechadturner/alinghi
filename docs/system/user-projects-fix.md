# User Projects Fix - Pending User Registration Issue

## Problem
When pending users completed registration, they were not being added to the `admin.user_projects` table, preventing them from accessing the projects they were invited to.

## Root Cause
The `admin.user_projects` table was missing a unique constraint on `(user_id, project_id)`, but the code was using PostgreSQL's `ON CONFLICT` clause which requires such a constraint:

```sql
INSERT INTO admin.user_projects (user_id, project_id, permission) 
VALUES ($1, $2, $3)
ON CONFLICT (user_id, project_id) DO UPDATE SET permission = EXCLUDED.permission
```

Without the constraint, PostgreSQL would fail with an error like:
```
there is no unique or exclusion constraint matching the ON CONFLICT specification
```

Since the `executeCommand` method in the shared database connection catches errors and returns `false` without throwing, the code would silently fail and continue execution, leaving the pending user without project permissions.

## Solution

### 1. Database Migration (Required)
Run the migration script to add the missing constraint:

```bash
psql -U postgres -d your_database -f database/migrations/add_user_projects_constraint.sql
```

This migration:
- Removes any duplicate entries in `user_projects` table
- Adds a unique constraint on `(user_id, project_id)`
- Creates indexes for better query performance

### 2. Code Updates (Completed)
Updated both registration flows to handle the permission transfer more robustly:

#### Updated Files:
- `server_app/controllers/auth_jwt.js` - Verify function
- `server_app/controllers/users.js` - addUser function
- `shared/database/connection.js` - Enhanced error logging

#### Changes Made:
1. **Check-then-Insert/Update Pattern**: Instead of relying on `ON CONFLICT`, the code now:
   - Checks if the permission already exists
   - If it exists: UPDATE the permission
   - If it doesn't: INSERT a new permission

2. **Error Handling**: Added proper result checking and error logging:
   - Checks if `executeCommand` returns success
   - Logs success messages when permissions are transferred
   - Logs error messages when operations fail

3. **Enhanced Logging**: Updated the shared database connection to log more details when errors occur:
   - Logs the SQL query that failed
   - Logs the parameters passed
   - Logs the full error object

## Testing
After applying the fix, test with a pending user:

1. Add a pending user to a project:
```sql
INSERT INTO admin.users_pending (project_id, email, permission) 
VALUES (1, 'test@example.com', 'contributor');
```

2. Have the user complete registration and verification

3. Verify they were added to user_projects:
```sql
SELECT * FROM admin.user_projects 
WHERE user_id = (SELECT user_id FROM admin.users WHERE email = 'test@example.com');
```

4. Verify they were removed from users_pending:
```sql
SELECT * FROM admin.users_pending WHERE email = 'test@example.com';
-- Should return 0 rows
```

## Benefits
1. **Works with or without constraint**: The new code works whether or not the unique constraint exists
2. **Better error visibility**: Failed operations are now logged with details
3. **Idempotent**: Can be run multiple times without issues
4. **Prevents duplicates**: Once the constraint is added, prevents duplicate permission entries

## Next Steps
1. **Apply the migration** to add the unique constraint to your database
2. **Monitor logs** during the next pending user registration to verify the fix
3. **Test thoroughly** with both single and multiple project invitations

## Related Files
- `server_app/controllers/auth_jwt.js`
- `server_app/controllers/users.js`
- `shared/database/connection.js`
- `database/migrations/add_user_projects_constraint.sql`
- `docs/pending-user-cleanup-implementation.md`

