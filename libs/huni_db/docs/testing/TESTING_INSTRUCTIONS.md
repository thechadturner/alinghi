# HuniDB Testing Instructions

## Quick Start

1. **Start the dev server:**
   ```bash
   cd libs/huni_db
   npm run dev
   ```

2. **Open in browser:**
   ```
   http://localhost:5174/basic.html
   ```

3. **Follow the checklist** in `TEST_CHECKLIST.md`

## Testing Order

Test in this order for best results:

1. **Initialize Database** - Must be done first
2. **Show Storage Info** - Verify storage type
3. **Run Migrations** - Create tables
4. **Migration Status** - Verify migration version
5. **Insert Sample Users** - Add test data
6. **Query All Users** - Verify data retrieval
7. **Query Single User** - Test queryOne
8. **Count Users** - Test queryValue
9. **Update User** - Test updates
10. **Run Transaction** - Test transactions
11. **Show Statistics** - Test cache stats
12. **Show Performance Metrics** - Test metrics
13. **Delete All Users** - Test deletes
14. **Close Database** - Test cleanup

## What to Look For

### ✅ Success Indicators:
- Green checkmarks (✓) in output
- Buttons become enabled after initialization
- Data appears in query results
- No red error messages
- Console shows INFO/DEBUG logs (not errors)

### ❌ Error Indicators:
- Red X (✗) in output
- Error messages in console
- Buttons stay disabled
- No data returned from queries
- Page freezes or crashes

## Known Issues to Watch For

1. **OPFS Fallback**: If OPFS fails, should automatically use memory storage
2. **SQLite WASM Loading**: May take a few seconds on first load
3. **CORS Headers**: Required for OPFS (handled by Vite config)

## Reporting Issues

When reporting issues, include:
- Browser and version
- Console errors (copy full error)
- Steps to reproduce
- Expected vs actual behavior

