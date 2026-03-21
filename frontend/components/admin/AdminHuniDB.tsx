import { createSignal, createMemo, onMount, Show, For, Match, Switch } from "solid-js";
import { huniDBStore } from "../../store/huniDBStore";
import { log, error as logError } from "../../utils/console";
import { logPageLoad } from "../../utils/logging";

interface TableInfo {
  name: string;
  type: string;
}

export default function AdminHuniDB() {
  const [className, setClassName] = createSignal<string>("");
  const [availableDatabases, setAvailableDatabases] = createSignal<string[]>([]);
  // Map of normalized class names to actual database names in IndexedDB
  const [databaseNameMap, setDatabaseNameMap] = createSignal<Map<string, string>>(new Map());
  const [tables, setTables] = createSignal<TableInfo[]>([]);
  const [showSystemTables, setShowSystemTables] = createSignal<boolean>(false);
  const [selectedTable, setSelectedTable] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal<boolean>(false);
  const [error, setError] = createSignal<string | null>(null);
  const [status, setStatus] = createSignal<"idle" | "connected" | "error">("idle");
  const [isClearing, setIsClearing] = createSignal<boolean>(false);

  // Content tabs: Data / SQL / Schema / Logs
  const [contentTab, setContentTab] = createSignal<"data" | "sql" | "schema" | "logs">("data");

  // Table data / schema state
  const [totalRows, setTotalRows] = createSignal<number>(0);
  const [page, setPage] = createSignal<number>(1);
  const [pageSize, setPageSize] = createSignal<number>(10);
  const [tableSchema, setTableSchema] = createSignal<any[]>([]);
  const [tableIndexes, setTableIndexes] = createSignal<any[]>([]);
  const [tableForeignKeys, setTableForeignKeys] = createSignal<any[]>([]);
  const [tableDef, setTableDef] = createSignal<string | null>(null);
  const [tableRows, setTableRows] = createSignal<any[]>([]);

  // SQL query state
  const [sqlQuery, setSqlQuery] = createSignal<string>("");
  const [sqlResultColumns, setSqlResultColumns] = createSignal<string[]>([]);
  const [sqlResultRows, setSqlResultRows] = createSignal<any[]>([]);
  const [sqlStatus, setSqlStatus] = createSignal<string | null>(null);

  // Logs panel state
  const [logs, setLogs] = createSignal<string>("");

  const appendLog = (message: string, level: "info" | "warn" | "error" | "success" = "info") => {
    const timestamp = new Date().toLocaleTimeString();
    const prefix =
      level === "error" ? "[ERROR]" : level === "warn" ? "[WARN]" : level === "success" ? "[OK]" : "[INFO]";
    const line = `[${timestamp}] ${prefix} ${message}\n`;
    setLogs((prev) => prev + line);

    // Also route to console logger
    if (level === "error") {
      logError("[HuniDB Admin]", message);
    } else {
      log("[HuniDB Admin]", message);
    }
  };

  /**
   * List all available databases from IndexedDB storage
   * Returns normalized class names (without the "hunico_" prefix) for display
   * Also updates the databaseNameMap with the mapping of normalized names to actual database names
   */
  const listAvailableDatabases = async (): Promise<string[]> => {
    const databases = new Set<string>();
    const nameMap = new Map<string, string>();
    
    try {
      // Open the hunidb_storage IndexedDB database
      // Use a fresh connection each time to ensure we get the latest data
      const request = indexedDB.open('hunidb_storage', 1);
      
      await new Promise<void>((resolve) => {
        request.onsuccess = () => {
          const db = request.result;
          try {
            const transaction = db.transaction(['databases'], 'readonly');
            const store = transaction.objectStore('databases');
            const getAllKeysRequest = store.getAllKeys();
            
            // Wait for transaction to complete to ensure we have fresh data
            transaction.oncomplete = () => {
              db.close();
              resolve();
            };
            
            transaction.onerror = () => {
              logError("[AdminHuniDB] Transaction error getting database keys:", transaction.error);
              db.close();
              resolve(); // Don't fail, just return what we have
            };
            
            getAllKeysRequest.onsuccess = () => {
              const keys = getAllKeysRequest.result as string[];
              log("[AdminHuniDB] Raw database keys from storage:", keys);
              keys.forEach((dbName: string) => {
                if (dbName && typeof dbName === 'string' && dbName.startsWith('hunico_')) {
                  // Skip temporary databases (those ending with __tmp)
                  if (dbName.endsWith('__tmp')) {
                    return;
                  }
                  // Extract class name by removing ALL "hunico_" prefixes (handles duplicate prefixes)
                  let normalizedName = dbName;
                  while (normalizedName.toLowerCase().startsWith('hunico_')) {
                    normalizedName = normalizedName.substring(7); // "hunico_".length = 7
                  }
                  if (normalizedName) {
                    databases.add(normalizedName);
                    // Store mapping: normalized name -> actual database name
                    nameMap.set(normalizedName, dbName);
                  }
                }
              });
            };
            
            getAllKeysRequest.onerror = () => {
              logError("[AdminHuniDB] Error getting database keys:", getAllKeysRequest.error);
              // Transaction will still complete, so we'll resolve there
            };
          } catch (error) {
            logError("[AdminHuniDB] Error accessing storage:", error);
            db.close();
            resolve(); // Don't fail, just return what we have
          }
        };
        
        request.onerror = () => {
          logError("[AdminHuniDB] Error opening storage:", request.error);
          resolve(); // Don't fail, just return empty array
        };
        
        request.onupgradeneeded = () => {
          // Database doesn't exist yet, nothing to list
          const db = request.result;
          if (!db.objectStoreNames.contains('databases')) {
            db.createObjectStore('databases', { keyPath: 'name' });
          }
        };
      });
    } catch (error) {
      logError("[AdminHuniDB] Error listing databases:", error);
    }
    
    // Update the name map
    setDatabaseNameMap(nameMap);
    
    const result = Array.from(databases).sort();
    log("[AdminHuniDB] Found available databases:", result);
    log("[AdminHuniDB] Database name mapping:", Array.from(nameMap.entries()));
    return result;
  };

  /**
   * Sync AUTOINCREMENT sequence values into a reusable _seq table.
   * This lets us reuse sequence information for tables like json.objects, json.targets, user_settings, etc.
   */
  const syncSequenceTable = async (currentClass: string) => {
    try {
      const db = await huniDBStore.getDatabase(currentClass);

      // Helper to safely quote string values for SQL
      const q = (value: string) => `'${String(value).replace(/'/g, "''")}'`;

      // Create the _seq table if it doesn't exist
      await db.exec(`
        CREATE TABLE IF NOT EXISTS "_seq" (
          table_name TEXT PRIMARY KEY,
          seq INTEGER,
          description TEXT
        );
      `);

      // Check if sqlite_sequence exists (only present when AUTOINCREMENT is used)
      const hasSeqTable = (await db.queryValue(`
        SELECT COUNT(*)
        FROM sqlite_master
        WHERE type = 'table' AND name = 'sqlite_sequence'
      `, undefined, undefined)) as number;

      if (!hasSeqTable) {
        appendLog(`No sqlite_sequence table found for class ${currentClass} – nothing to sync into _seq.`, "info");
        return;
      }

      // Read all sequences from sqlite_sequence
      const seqRows = (await db.query(`
        SELECT name AS table_name, seq
        FROM sqlite_sequence
      `, undefined, undefined)) as { table_name: string; seq: number | null }[];

      for (const row of seqRows) {
        const tableName = row.table_name;
        const seq = row.seq ?? 0;

        // Use a friendly description – for user_settings we want it to just be "user_settings"
        const description =
          tableName === "user_settings"
            ? "user_settings"
            : tableName;

        await db.exec(`
          INSERT INTO "_seq" (table_name, seq, description)
          VALUES (${q(tableName)}, ${seq}, ${q(description)})
          ON CONFLICT(table_name) DO UPDATE SET
            seq = excluded.seq,
            description = excluded.description;
        `);
      }

      appendLog(`Synced ${seqRows.length} sequence value(s) into _seq for class ${currentClass}.`, "info");
    } catch (e: any) {
      logError("[AdminHuniDB] Failed to sync _seq table:", e);
      appendLog(`Failed to sync _seq table: ${e?.message || String(e)}`, "error");
    }
  };

  const loadTables = async () => {
    const currentClass = className().trim();
    if (!currentClass) {
      setError("Please select a database to inspect.");
      setTables([]);
      setStatus("idle");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      log("[AdminHuniDB] Loading tables for class:", currentClass);
      const result = await huniDBStore.listTables(currentClass);
      setTables(result);

      // Sync sequence information into _seq for reuse across tables
      await syncSequenceTable(currentClass);

      // Automatically select the first table that is actually visible
      const visibleTables = showSystemTables()
        ? result
        : result.filter((t) => !t.name.startsWith("_"));

      if (visibleTables.length > 0) {
        const firstName = visibleTables[0].name;
        // Use the same selection path as a manual click so data loads immediately
        await handleSelectTable(firstName);
      } else {
        setSelectedTable(null);
        setTableRows([]);
        setTableSchema([]);
        setTableIndexes([]);
        setTableForeignKeys([]);
        setTableDef(null);
        setTotalRows(0);
      }

      setStatus("connected");
      appendLog(`Loaded ${result.length} table(s) for class ${currentClass}`, "info");
    } catch (e: any) {
      logError("[AdminHuniDB] Failed to load tables:", e);
      setError(e?.message || "Failed to load tables for this class.");
      setTables([]);
      setStatus("error");
    } finally {
      setLoading(false);
    }
  };

  /**
   * Handle database selection change - reconnect and reload tables
   */
  const handleDatabaseChange = async (newClassName: string) => {
    if (!newClassName || newClassName === className()) {
      return;
    }
    
    setClassName(newClassName);
    
    // Clear current state
    setTables([]);
    setSelectedTable(null);
    setTableRows([]);
    setTableSchema([]);
    setTableIndexes([]);
    setTableForeignKeys([]);
    setTableDef(null);
    setTotalRows(0);
    setSqlQuery("");
    setSqlResultColumns([]);
    setSqlResultRows([]);
    setSqlStatus(null);
    
    // Load tables for the new database
    await loadTables();
  };


  const handleRemoveDatabase = async () => {
    const selectedNormalizedName = className().trim();
    if (!selectedNormalizedName) {
      setError("Please select a database to remove.");
      return;
    }

    // Get the actual database name from the map
    const nameMap = databaseNameMap();
    const actualDbName = nameMap.get(selectedNormalizedName);
    
    if (!actualDbName) {
      setError(`Could not find actual database name for "${selectedNormalizedName}". Please refresh the page.`);
      return;
    }

    const confirmRemove = window.confirm(
      `This will permanently remove all HuniDB data for class "${selectedNormalizedName}" (database: ${actualDbName}) from this browser.\n\n` +
      `Charts and maps will re-fetch data from the server the next time they run.\n\n` +
      `Are you absolutely sure you want to remove this database?`
    );
    if (!confirmRemove) {
      return;
    }

    setIsClearing(true);
    setError(null);
    try {
      log("[AdminHuniDB] Removing database:", {
        normalizedName: selectedNormalizedName,
        actualDbName: actualDbName
      });
      
      // Get list before deletion for comparison
      const databasesBefore = await listAvailableDatabases();
      log("[AdminHuniDB] Databases before removal:", databasesBefore);
      
      // Delete using the actual database name directly from IndexedDB
      // We need to delete it directly, not through clearDatabase which normalizes
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open('hunidb_storage', 1);
        
        request.onsuccess = () => {
          const db = request.result;
          try {
            const transaction = db.transaction(['databases'], 'readwrite');
            const store = transaction.objectStore('databases');
            const deleteRequest = store.delete(actualDbName);
            
            transaction.oncomplete = () => {
              log("[AdminHuniDB] Successfully deleted database from IndexedDB:", actualDbName);
              db.close();
              resolve();
            };
            
            transaction.onerror = () => {
              logError("[AdminHuniDB] Transaction error:", transaction.error);
              db.close();
              reject(transaction.error);
            };
            
            deleteRequest.onsuccess = () => {
              log("[AdminHuniDB] Delete request succeeded for:", actualDbName);
            };
            
            deleteRequest.onerror = () => {
              logError("[AdminHuniDB] Delete request failed:", deleteRequest.error);
            };
          } catch (error) {
            db.close();
            reject(error);
          }
        };
        
        request.onerror = () => {
          logError("[AdminHuniDB] Failed to open storage:", request.error);
          reject(request.error);
        };
        
        request.onupgradeneeded = () => {
          const db = request.result;
          if (!db.objectStoreNames.contains('databases')) {
            db.createObjectStore('databases', { keyPath: 'name' });
          }
        };
      });
      
      // Also close any open connections to this database
      try {
        // Extract normalized class name for clearDatabase (it will handle the connection cleanup)
        let normalizedClass = actualDbName;
        while (normalizedClass.toLowerCase().startsWith('hunico_')) {
          normalizedClass = normalizedClass.substring(7);
        }
        await huniDBStore.clearDatabase(normalizedClass);
      } catch (clearError) {
        // Ignore errors from clearDatabase - we already deleted from storage
        log("[AdminHuniDB] Note: clearDatabase had issues (expected if database already deleted):", clearError);
      }
      
      // Wait a bit to ensure deletion is fully persisted
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Wait a bit more to ensure IndexedDB has fully processed the deletion
      await new Promise(resolve => setTimeout(resolve, 300));
      
      // Refresh available databases list with a fresh query
      const updatedDatabases = await listAvailableDatabases();
      log("[AdminHuniDB] Databases after removal:", updatedDatabases);
      
      // Verify the database was actually removed
      const wasRemoved = !updatedDatabases.includes(selectedNormalizedName);
      if (!wasRemoved) {
        logError("[AdminHuniDB] Database still appears in list after removal attempt!", {
          selectedNormalizedName,
          actualDbName,
          updatedDatabases
        });
        setError(`Database removal may have failed. Database "${selectedNormalizedName}" still appears in the list. Try refreshing the page.`);
        appendLog(`Warning: Database ${selectedNormalizedName} may not have been fully removed`, "error");
      } else {
        appendLog(`Successfully removed HuniDB database for class ${selectedNormalizedName}`, "success");
      }
      
      setAvailableDatabases(updatedDatabases);
      
      // Clear current state
      setTables([]);
      setSelectedTable(null);
      setStatus("idle");
      setTableRows([]);
      setTableSchema([]);
      setTableIndexes([]);
      setTableForeignKeys([]);
      setTableDef(null);
      setTotalRows(0);
      
      // Select first available database if any, otherwise clear selection
      if (updatedDatabases.length > 0) {
        setClassName(updatedDatabases[0]);
        await loadTables();
      } else {
        setClassName("");
      }
    } catch (e: any) {
      logError("[AdminHuniDB] Failed to remove database:", e);
      const errorMessage = e?.message || "Failed to remove database.";
      setError(errorMessage);
      appendLog(`Error removing database: ${errorMessage}`, "error");
    } finally {
      setIsClearing(false);
    }
  };

  onMount(async () => {
    await logPageLoad("AdminHuniDB.tsx", "HuniDB Admin Page");
    
    // Load available databases
    const databases = await listAvailableDatabases();
    setAvailableDatabases(databases);
    
    // Auto-select first database if available
    if (databases.length > 0) {
      setClassName(databases[0]);
      await loadTables();
    } else {
      appendLog("No databases found in IndexedDB storage.", "info");
    }
  });

  const loadTableData = async () => {
    const currentClass = className().trim();
    const tableName = selectedTable();
    if (!currentClass || !tableName) {
      return;
    }

    try {
      const db = await huniDBStore.getDatabase(currentClass);

      // Total rows
      const countResult = (await db.queryValue(
        `SELECT COUNT(*) FROM ${tableName.includes('"') ? tableName : `"${tableName}"`}`,
        undefined,
        undefined
      )) as number | null;
      const total = countResult || 0;
      setTotalRows(total);

      // Schema
      const schema = (await db.query(`
        SELECT 
          name, 
          type, 
          pk, 
          dflt_value, 
          "notnull" AS not_null,
          cid
        FROM pragma_table_info(${quoteValue(tableName)})
        ORDER BY cid
      `, undefined, undefined)) as any[];
      setTableSchema(schema);

      // Indexes and index columns
      const indexes = (await db.query(`
        SELECT 
          name,
          "unique" AS is_unique,
          origin,
          partial
        FROM pragma_index_list(${quoteValue(tableName)})
      `, undefined, undefined)) as any[];
      const indexDetails: any[] = [];
      for (const idx of indexes) {
        const columns = (await db.query(`
          SELECT 
            seqno,
            cid,
            name
          FROM pragma_index_info(${quoteValue(idx.name)})
          ORDER BY seqno
        `, undefined, undefined)) as any[];
        indexDetails.push({ ...idx, columns });
      }
      setTableIndexes(indexDetails);

      // Foreign keys
      const foreignKeys = (await db.query(`
        SELECT 
          id,
          seq,
          "table" AS table_name,
          "from" AS from_column,
          "to" AS to_column
        FROM pragma_foreign_key_list(${quoteValue(tableName)})
        ORDER BY id, seq
      `, undefined, undefined)) as any[];
      setTableForeignKeys(foreignKeys);

      // Table definition
      const tableDefRows = (await db.query(`
        SELECT sql
        FROM sqlite_master
        WHERE type = 'table' AND name = ${quoteValue(tableName)}
      `, undefined, undefined)) as any[];
      setTableDef(tableDefRows[0]?.sql || null);

      // Page of data
      const currentPage = page();
      const size = pageSize();
      const offset = (currentPage - 1) * size;
      const rows = (await db.query(
        `SELECT * FROM ${tableName.includes('"') ? tableName : `"${tableName}"`} LIMIT ? OFFSET ?`,
        [size, offset],
        undefined
      )) as any[];
      setTableRows(rows);

      appendLog(
        `Loaded ${rows.length} row(s) from ${tableName} (page ${currentPage}, total ${total.toLocaleString()})`,
        "info"
      );
    } catch (e: any) {
      appendLog(`Error loading data for table ${selectedTable()}: ${e?.message || String(e)}`, "error");
      setTableRows([]);
    }
  };

  const handleSelectTable = async (name: string) => {
    setSelectedTable(name);
    setPage(1);
    setContentTab("data");
    setSqlQuery("");
    setSqlResultColumns([]);
    setSqlResultRows([]);
    setSqlStatus(null);
    setLogs("");
    await loadTableData();
  };

  const handleChangePageSize = async (value: string) => {
    const size = parseInt(value, 10) || 50;
    setPageSize(size);
    setPage(1);
    setContentTab("data");
    await loadTableData();
  };

  const handleGoToPage = async (newPage: number) => {
    const total = totalRows();
    const size = pageSize();
    const totalPages = Math.max(1, Math.ceil(total / size));
    const clamped = Math.min(Math.max(newPage, 1), totalPages);
    setPage(clamped);
    setContentTab("data");
    await loadTableData();
  };

  const handleRefreshData = async () => {
    await loadTableData();
  };

  const handleExecuteQuery = async () => {
    const currentClass = className().trim();
    const currentSql = sqlQuery().trim();
    if (!currentClass || !currentSql) {
      setSqlStatus("Please enter a SQL query.");
      return;
    }

    try {
      const db = await huniDBStore.getDatabase(currentClass);
      appendLog(`Executing query: ${currentSql.substring(0, 120)}${currentSql.length > 120 ? "..." : ""}`, "info");
      const start = performance.now();
      const result = (await db.query(currentSql, undefined, undefined)) as any[];
      const end = performance.now();
      const elapsed = (end - start).toFixed(2);

      if (!result || result.length === 0) {
        setSqlResultColumns([]);
        setSqlResultRows([]);
        setSqlStatus(`Query executed successfully in ${elapsed}ms (0 rows).`);
        appendLog(`Query executed successfully in ${elapsed}ms (0 rows).`, "success");
        return;
      }

      const cols = Object.keys(result[0] ?? {});
      setSqlResultColumns(cols);
      setSqlResultRows(result);
      setSqlStatus(`Query executed successfully in ${elapsed}ms (${result.length} row(s)).`);
      appendLog(`Query executed successfully in ${elapsed}ms (${result.length} row(s)).`, "success");
    } catch (e: any) {
      const msg = e?.message || String(e);
      setSqlStatus(`Query error: ${msg}`);
      appendLog(`Query error: ${msg}`, "error");
    }
  };

  const handleClearQuery = () => {
    setSqlQuery("");
    setSqlResultColumns([]);
    setSqlResultRows([]);
    setSqlStatus(null);
  };

  const handleClearLogs = () => {
    setLogs("");
  };

  const quoteValue = (value: string) => `'${String(value).replace(/'/g, "''")}'`;

  // Helper for SQL placeholder example – quote table names that contain dots
  const getExampleTableName = () => {
    const table = selectedTable();
    if (!table) {
      return "my_table";
    }
    // Use double quotes when table names contain dots (e.g. "agg.events")
    return table.includes(".") ? `"${table}"` : table;
  };

  // Filtered tables list based on showSystemTables checkbox
  const filteredTables = createMemo(() => {
    const allTables = tables();
    if (showSystemTables()) {
      return allTables;
    }
    // Hide tables that start with "_" (system tables)
    return allTables.filter(table => !table.name.startsWith('_'));
  });

  const formatCell = (value: any) => {
    if (value === null || value === undefined) {
      return <span class="text-gray-400">NULL</span>;
    }
    if (typeof value === "object") {
      return (
        <span class="font-mono text-xs">
          {JSON.stringify(value).length > 200
            ? JSON.stringify(value).slice(0, 200) + "…"
            : JSON.stringify(value)}
        </span>
      );
    }
    return String(value);
  };

  return (
    <div class="admin-hunidb">
      <div class="admin-page-header">
        <div>
          <h1>HuniDB Admin</h1>
          <p>Database administration and exploration tool for client-side HuniDB storage in this browser.</p>
        </div>
        <div class="flex items-center gap-3">
          <span
            class={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${
              status() === "connected"
                ? "bg-green-100 text-green-800"
                : status() === "error"
                ? "bg-red-100 text-red-800"
                : "bg-gray-100 text-gray-800"
            }`}
          >
            {status() === "connected" && "Connected"}
            {status() === "error" && "Error"}
            {status() === "idle" && "Idle"}
          </span>
        </div>
      </div>

      <div class="mt-4 grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Left column: database (class) selection and table list */}
        <div
          class="rounded-lg p-4 shadow-sm lg:col-span-1"
          style={{
            "background-color": "var(--color-bg-secondary)",
            "border": "1px solid var(--color-border-primary)",
          }}
        >
          <h2 class="text-sm font-semibold text-black dark:text-white mb-1">
            Database
          </h2>

          <div class="mb-4 mt-2">
            <select
              class="w-full px-3 py-2 border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              style={{
                "border-color": "var(--color-border-primary)",
                "background-color": "var(--color-bg-secondary)",
                "color": "var(--color-text-primary)",
                "transition": "background-color 0.3s ease, border-color 0.3s ease, color 0.3s ease"
              }}
              value={className()}
              onChange={(e) => void handleDatabaseChange(e.currentTarget.value)}
              disabled={loading()}
            >
              <option value="">-- Select database --</option>
              <For each={availableDatabases()}>
                {(dbName) => (
                  <option value={dbName}>{dbName}</option>
                )}
              </For>
            </select>
          </div>

          <h2 class="text-sm font-semibold text-black dark:text-white mt-4 mb-1">
            Tables
          </h2>

          <Show when={tables().length > 0} fallback={
            <p class="mt-2 text-xs text-gray-500 dark:text-gray-400">
              Load a class database to see its tables. Tables are created automatically when data is stored.
            </p>
          }>
            <div class="mt-1">
              <p class="text-xs mb-1" style={{ "color": "var(--color-text-secondary)" }}>
                Tables in this class database ({filteredTables().length}):
              </p>
              <div 
                class="overflow-y-auto border rounded-md"
                style={{ 
                  "min-height": "200px", 
                  "max-height": "600px",
                  "border-color": "var(--color-border-primary)",
                  "background-color": "var(--color-bg-card)",
                  "transition": "background-color 0.3s ease, border-color 0.3s ease"
                }}
              >
                <For each={filteredTables()}>
                  {(table) => (
                    <button
                      class={`w-full text-left px-3 py-2 text-sm border-b hover:bg-blue-50 ${
                        selectedTable() === table.name
                          ? "bg-blue-50 font-semibold"
                          : ""
                      }`}
                      style={{
                        "border-color": "var(--color-border-primary)",
                        "background-color": selectedTable() === table.name 
                          ? "var(--color-bg-secondary)" 
                          : "var(--color-bg-card)",
                        "transition": "background-color 0.3s ease, border-color 0.3s ease"
                      }}
                      onClick={() => handleSelectTable(table.name)}
                    >
                      <div class="flex items-center justify-between">
                        <span class="truncate" style={{ "color": "var(--color-text-primary)" }}>{table.name}</span>
                        <span class="ml-2 text-[10px] uppercase" style={{ "color": "var(--color-text-tertiary)" }}>
                          {table.type}
                        </span>
                      </div>
                    </button>
                  )}
                </For>
              </div>
              <div class="mt-2">
                <label class="flex items-center gap-2 text-xs cursor-pointer" style={{ "color": "var(--color-text-secondary)" }}>
                  <input
                    type="checkbox"
                    checked={showSystemTables()}
                    onChange={(e) => setShowSystemTables(e.currentTarget.checked)}
                    class="w-4 h-4 text-blue-600 border-gray-300 rounded focus:ring-blue-500"
                  />
                  <span>Show system tables</span>
                </label>
              </div>
            </div>
          </Show>

          <Show when={error()}>
            <p class="mt-3 text-xs text-red-600 dark:text-red-400 whitespace-pre-wrap">
              {error()}
            </p>
          </Show>
        </div>

        {/* Right column: content tabs (Data / SQL / Schema / Logs) and actions */}
        <div
          class="rounded-lg shadow-sm lg:col-span-2 flex flex-col"
          style={{
            "background-color": "var(--color-bg-card)",
            "border": "1px solid var(--color-border-primary)",
          }}
        >
          {/* Header */}
          <div
            class="px-4 pt-4 pb-3"
            style={{
              "border-bottom": "1px solid var(--color-border-primary)",
              "background-color": "var(--color-bg-secondary)",
            }}
          >
            <h2 class="text-sm font-semibold text-black dark:text-white">
              Table &amp; query console
            </h2>
            <p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
              View table data, run SQL, inspect schema, and review logs for local HuniDB storage in this browser.
            </p>
          </div>

          {/* Content tabs */}
          <div 
            class="flex border-b px-4"
            style={{
              "border-color": "var(--color-border-primary)",
              "background-color": "var(--color-bg-secondary)",
              "transition": "background-color 0.3s ease, border-color 0.3s ease"
            }}
          >
            <button
              class={`px-4 py-2 text-xs font-medium border-b-2 ${
                contentTab() === "data"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent hover:text-blue-600 hover:border-blue-400"
              }`}
              style={{
                "color": contentTab() === "data" ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                "transition": "color 0.3s ease"
              }}
              onClick={() => setContentTab("data")}
            >
              Data
            </button>
            <button
              class={`px-4 py-2 text-xs font-medium border-b-2 ${
                contentTab() === "sql"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent hover:text-blue-600 hover:border-blue-400"
              }`}
              style={{
                "color": contentTab() === "sql" ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                "transition": "color 0.3s ease"
              }}
              onClick={() => setContentTab("sql")}
            >
              SQL
            </button>
            <button
              class={`px-4 py-2 text-xs font-medium border-b-2 ${
                contentTab() === "schema"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent hover:text-blue-600 hover:border-blue-400"
              }`}
              style={{
                "color": contentTab() === "schema" ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                "transition": "color 0.3s ease"
              }}
              onClick={() => setContentTab("schema")}
            >
              Schema
            </button>
            <button
              class={`px-4 py-2 text-xs font-medium border-b-2 ${
                contentTab() === "logs"
                  ? "border-blue-500 text-blue-600"
                  : "border-transparent hover:text-blue-600 hover:border-blue-400"
              }`}
              style={{
                "color": contentTab() === "logs" ? "var(--color-text-primary)" : "var(--color-text-secondary)",
                "transition": "color 0.3s ease"
              }}
              onClick={() => setContentTab("logs")}
            >
              Logs
            </button>
          </div>

          {/* Panels */}
          <div class="flex-1 p-4 text-xs overflow-hidden" style={{ "color": "var(--color-text-primary)" }}>
            <Switch>
              {/* Data panel */}
              <Match when={contentTab() === "data"}>
                <Show
                  when={selectedTable()}
                  fallback={
                    <div class="h-full flex items-center justify-center text-gray-500 dark:text-gray-400">
                      Select a table on the left to view its data.
                    </div>
                  }
                >
                <div class="flex flex-col h-full">
                    <div
                      class="mb-3 rounded-lg p-3"
                      style={{
                        "background-color": "var(--color-bg-secondary)",
                        "border": "1px solid var(--color-border-primary)",
                      }}
                    >
                    <div class="flex items-center justify-between gap-3">
                      <div>
                        <div class="text-sm font-semibold text-black dark:text-white">
                          {selectedTable()}{" "}
                          <span class="text-[11px] font-normal text-gray-500 dark:text-gray-400">
                            ({totalRows().toLocaleString()} row(s))
                          </span>
                        </div>
                        <div class="mt-0.5 text-[11px] text-gray-500 dark:text-gray-400">
                          Page {page()} of{" "}
                          {Math.max(1, Math.ceil((totalRows() || 0) / (pageSize() || 1)))}
                        </div>
                      </div>
                      <div class="flex items-end gap-3">
                        <div>
                          <label class="block text-[11px] font-medium mb-0.5" style={{ "color": "var(--color-text-primary)" }}>
                            Page size
                          </label>
                          <select
                            class="w-24 px-2 py-1 border rounded-md text-[11px] focus:outline-none focus:ring-2 focus:ring-blue-500"
                            style={{
                              "border-color": "var(--color-border-primary)",
                              "background-color": "var(--color-bg-secondary)",
                              "color": "var(--color-text-primary)",
                              "transition": "background-color 0.3s ease, border-color 0.3s ease, color 0.3s ease"
                            }}
                            value={pageSize()}
                            onChange={(e) => void handleChangePageSize(e.currentTarget.value)}
                          >
                            <option value="10">10</option>
                            <option value="25">25</option>
                            <option value="50">50</option>
                            <option value="100">100</option>
                            <option value="200">200</option>
                          </select>
                        </div>
                        <div>
                          <label class="block text-[11px] font-medium text-transparent mb-0.5">
                            Refresh
                          </label>
                          <button
                            class="px-3 py-1.5 text-[11px] rounded-md bg-white dark:bg-gray-800 border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700"
                            onClick={() => void handleRefreshData()}
                          >
                            Refresh
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>

                    <div class="admin-table-container">
                      <div class="admin-table">
                        <Show
                          when={tableRows().length > 0 && tableSchema().length > 0}
                          fallback={
                            <div class="h-full flex items-center justify-center" style={{ "color": "var(--color-text-tertiary)" }}>
                              {totalRows() === 0
                                ? "No data in this table."
                                : "No rows loaded yet. Try refreshing."}
                            </div>
                          }
                        >
                          <div class="overflow-auto h-full">
                            <table class="w-full border-collapse border border-gray-200 text-left">
                              <thead class="bg-gray-200 sticky top-0 z-20">
                                <tr>
                                  <For each={tableSchema()}>
                                    {(col: any) => (
                                      <th class="border border-gray-300 px-4 py-2 font-semibold">
                                        <span>{col.name}</span>
                                        <span class="ml-1 text-xs text-gray-500">({col.type})</span>
                                      </th>
                                    )}
                                  </For>
                                </tr>
                              </thead>
                              <tbody
                                class="bg-white"
                                style={{ "background-color": "var(--color-bg-card)" }}
                              >
                                <For each={tableRows()}>
                                  {(row: any) => (
                                    <tr
                                      class="border border-gray-200 hover:bg-gray-50"
                                      style={{ "background-color": "var(--color-bg-card)" }}
                                    >
                                      <For each={tableSchema()}>
                                        {(col: any) => (
                                          <td class="px-4 py-2 text-sm text-gray-600">
                                            {formatCell(row[col.name])}
                                          </td>
                                        )}
                                      </For>
                                    </tr>
                                  )}
                                </For>
                              </tbody>
                            </table>
                          </div>
                        </Show>
                      </div>
                    </div>

                    <div class="mt-3 flex items-center justify-between text-[11px]" style={{ "color": "var(--color-text-secondary)" }}>
                      <div>
                        Showing{" "}
                        {totalRows() === 0
                          ? 0
                          : (page() - 1) * pageSize() + 1}{" "}
                        -{" "}
                        {Math.min(page() * pageSize(), totalRows())} of{" "}
                        {totalRows().toLocaleString()} rows
                      </div>
                      <div class="flex items-center gap-1">
                        <button
                          class="px-2 py-1 rounded-md border border-gray-300 disabled:opacity-50"
                          style={{
                            "background-color": "var(--color-bg-card)",
                            "color": "var(--color-text-primary)",
                            "transition": "background-color 0.3s ease"
                          }}
                          disabled={page() === 1}
                          onClick={() => void handleGoToPage(1)}
                        >
                          First
                        </button>
                        <button
                          class="px-2 py-1 rounded-md border border-gray-300 disabled:opacity-50"
                          style={{
                            "background-color": "var(--color-bg-card)",
                            "color": "var(--color-text-primary)",
                            "transition": "background-color 0.3s ease"
                          }}
                          disabled={page() === 1}
                          onClick={() => void handleGoToPage(page() - 1)}
                        >
                          Prev
                        </button>
                        <span class="px-2">
                          Page {page()} /{" "}
                          {Math.max(1, Math.ceil((totalRows() || 0) / (pageSize() || 1)))}
                        </span>
                        <button
                          class="px-2 py-1 rounded-md border border-gray-300 disabled:opacity-50"
                          style={{
                            "background-color": "var(--color-bg-card)",
                            "color": "var(--color-text-primary)",
                            "transition": "background-color 0.3s ease"
                          }}
                          disabled={page() >= Math.max(1, Math.ceil((totalRows() || 0) / (pageSize() || 1)))}
                          onClick={() => void handleGoToPage(page() + 1)}
                        >
                          Next
                        </button>
                        <button
                          class="px-2 py-1 rounded-md border border-gray-300 disabled:opacity-50"
                          style={{
                            "background-color": "var(--color-bg-card)",
                            "color": "var(--color-text-primary)",
                            "transition": "background-color 0.3s ease"
                          }}
                          disabled={page() >= Math.max(1, Math.ceil((totalRows() || 0) / (pageSize() || 1)))}
                          onClick={() =>
                            void handleGoToPage(Math.max(1, Math.ceil((totalRows() || 0) / (pageSize() || 1))))}
                        >
                          Last
                        </button>
                      </div>
                    </div>
                  </div>
                </Show>
              </Match>

              {/* SQL panel */}
              <Match when={contentTab() === "sql"}>
                <div class="flex flex-col h-full gap-3">
                  <div
                    class="rounded-lg p-3"
                    style={{
                      "background-color": "var(--color-bg-secondary)",
                      "border": "1px solid var(--color-border-primary)",
                    }}
                  >
                    <div class="mb-2">
                      <label class="block text-sm font-medium text-gray-700 mb-1">
                        SQL query
                      </label>
                      <textarea
                        class="w-full h-32 border border-gray-300 rounded-md text-xs font-mono p-2 resize-y focus:outline-none focus:ring-2 focus:ring-blue-500"
                        style={{
                          "background-color": "#374151",
                          "color": "#000000"
                        }}
                        placeholder={`Enter your SQL query here...\nExample: SELECT * FROM ${getExampleTableName()} LIMIT 10`}
                        value={sqlQuery()}
                        onInput={(e) => setSqlQuery(e.currentTarget.value)}
                      />
                    </div>
                    <div class="flex items-center gap-2">
                      <button
                        class="px-3 py-1.5 text-xs rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                        onClick={() => void handleExecuteQuery()}
                      >
                        Execute query
                      </button>
                      <button
                        class="px-3 py-1.5 text-xs rounded-md bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 text-gray-800 dark:text-gray-200"
                        onClick={handleClearQuery}
                      >
                        Clear
                      </button>
                      <Show when={sqlStatus()}>
                        <span class="text-[11px] text-gray-600 dark:text-gray-300">
                          {sqlStatus()}
                        </span>
                      </Show>
                    </div>
                  </div>
                  <div class="admin-table-container">
                    <div class="admin-table">
                      <Show
                        when={sqlResultColumns().length > 0}
                        fallback={
                          <div class="h-full flex items-center justify-center" style={{ "color": "var(--color-text-tertiary)" }}>
                            Enter a SQL query and click &quot;Execute query&quot; to see results.
                          </div>
                        }
                      >
                        <div class="overflow-auto h-full">
                          <table class="w-full border-collapse border border-gray-200 text-left">
                            <thead class="bg-gray-200 sticky top-0 z-20">
                              <tr>
                                <For each={sqlResultColumns()}>
                                  {(col) => (
                                    <th class="border border-gray-300 px-4 py-2 font-semibold">
                                      {col}
                                    </th>
                                  )}
                                </For>
                              </tr>
                            </thead>
                            <tbody
                              class="bg-white"
                              style={{ "background-color": "var(--color-bg-card)" }}
                            >
                              <For each={sqlResultRows()}>
                                {(row: any) => (
                                  <tr
                                    class="border border-gray-200 hover:bg-gray-50"
                                    style={{ "background-color": "var(--color-bg-card)" }}
                                  >
                                    <For each={sqlResultColumns()}>
                                      {(col) => (
                                        <td class="px-4 py-2 text-sm text-gray-600">
                                          {formatCell(row[col])}
                                        </td>
                                      )}
                                    </For>
                                  </tr>
                                )}
                              </For>
                            </tbody>
                          </table>
                        </div>
                      </Show>
                    </div>
                  </div>
                </div>
              </Match>

              {/* Schema panel */}
              <Match when={contentTab() === "schema"}>
                <Show
                  when={selectedTable()}
                  fallback={
                    <div class="h-full flex items-center justify-center text-gray-500 dark:text-gray-400">
                      Select a table on the left to view its schema.
                    </div>
                  }
                >
                  <div class="flex flex-col gap-3 h-full overflow-auto pr-1">
                    <div class="text-sm font-semibold text-black dark:text-white">
                      {selectedTable()}{" "}
                      <span class="text-[11px] font-normal text-gray-500 dark:text-gray-400">
                        • {totalRows().toLocaleString()} row(s) • {tableSchema().length} column(s) •{" "}
                        {tableIndexes().length} index(es) • {tableForeignKeys().length} foreign key(s)
                      </span>
                    </div>

                    {/* Columns */}
                    <div>
                      <div class="text-[11px] font-semibold text-gray-700 dark:text-gray-200 mb-1">
                        Columns
                      </div>
                      <div class="border border-gray-200 rounded overflow-hidden">
                        <table class="w-full border-collapse border border-gray-200 text-left">
                          <thead class="bg-gray-200 sticky top-0 z-20">
                            <tr>
                              <th class="border border-gray-300 px-4 py-2 font-semibold">Name</th>
                              <th class="border border-gray-300 px-4 py-2 font-semibold">Type</th>
                              <th class="border border-gray-300 px-4 py-2 font-semibold">PK</th>
                              <th class="border border-gray-300 px-4 py-2 font-semibold">Not null</th>
                              <th class="border border-gray-300 px-4 py-2 font-semibold">Default</th>
                            </tr>
                          </thead>
                          <tbody class="bg-white" style={{ "background-color": "var(--color-bg-card)" }}>
                            <For each={tableSchema()}>
                              {(col: any) => (
                                <tr class="border border-gray-200 hover:bg-gray-50" style={{ "background-color": "var(--color-bg-card)" }}>
                                  <td class="px-4 py-2 text-sm text-gray-600 font-semibold">
                                    {col.name}
                                    {col.pk ? " 🔑" : ""}
                                  </td>
                                  <td class="px-4 py-2 text-sm text-gray-600 font-mono">{col.type}</td>
                                  <td class="px-4 py-2 text-sm text-gray-600">{col.pk ? "✓" : "—"}</td>
                                  <td class="px-4 py-2 text-sm text-gray-600">{col.not_null ? "✓" : "—"}</td>
                                  <td class="px-4 py-2 text-sm text-gray-600 font-mono">
                                    {col.dflt_value ?? "—"}
                                  </td>
                                </tr>
                              )}
                            </For>
                          </tbody>
                        </table>
                      </div>
                    </div>

                    {/* Indexes */}
                    <Show when={tableIndexes().length > 0}>
                      <div>
                        <div class="text-[11px] font-semibold text-gray-700 dark:text-gray-200 mb-1">
                          Indexes
                        </div>
                        <div class="space-y-1">
                          <For each={tableIndexes()}>
                            {(idx: any) => (
                              <div class="border border-gray-200 dark:border-gray-800 rounded px-2 py-1 bg-gray-50 dark:bg-gray-900">
                                <div class="text-[11px] font-semibold text-gray-800 dark:text-gray-100">
                                  {idx.name}{" "}
                                  {idx.is_unique ? (
                                    <span class="ml-1 text-[10px] text-green-600 dark:text-green-400">UNIQUE</span>
                                  ) : null}
                                  <span class="ml-1 text-[10px] text-gray-500">
                                    ({idx.origin || "manual"})
                                  </span>
                                </div>
                                <div class="text-[11px] text-gray-600 dark:text-gray-300">
                                  Columns:{" "}
                                  {Array.isArray(idx.columns)
                                    ? idx.columns.map((c: any) => c.name || `column_${c.cid}`).join(", ")
                                    : ""}
                                </div>
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    {/* Foreign keys */}
                    <Show when={tableForeignKeys().length > 0}>
                      <div>
                        <div class="text-[11px] font-semibold text-gray-700 dark:text-gray-200 mb-1">
                          Foreign keys
                        </div>
                        <div class="space-y-1">
                          <For each={tableForeignKeys()}>
                            {(fk: any) => (
                              <div class="border border-gray-200 dark:border-gray-800 rounded px-2 py-1 bg-gray-50 dark:bg-gray-900 text-[11px]">
                                {fk.from_column} → {fk.table_name}.{fk.to_column}
                              </div>
                            )}
                          </For>
                        </div>
                      </div>
                    </Show>

                    {/* Table definition */}
                    <Show when={tableDef()}>
                      <div>
                        <div class="text-[11px] font-semibold text-gray-700 dark:text-gray-200 mb-1">
                          Table definition
                        </div>
                        <textarea
                          class="w-full border border-gray-200 dark:border-gray-800 rounded bg-gray-50 dark:bg-gray-900 text-[11px] font-mono p-2"
                          rows={6}
                          readonly
                          value={tableDef() || ""}
                        />
                      </div>
                    </Show>
                  </div>
                </Show>
              </Match>

              {/* Logs panel */}
              <Match when={contentTab() === "logs"}>
                <div class="flex flex-col h-full">
                  <div
                    class="rounded-lg p-3 mb-2"
                    style={{
                      "background-color": "var(--color-bg-secondary)",
                      "border": "1px solid var(--color-border-primary)",
                    }}
                  >
                    <div class="flex items-center justify-between">
                      <div class="text-[11px] text-gray-600 dark:text-gray-300">
                        Logs for recent HuniDB admin operations in this session.
                      </div>
                      <button
                        class="px-3 py-1.5 text-xs rounded-md bg-white dark:bg-gray-900 border border-gray-300 dark:border-gray-700 hover:bg-gray-100 dark:hover:bg-gray-800"
                        onClick={handleClearLogs}
                      >
                        Clear logs
                      </button>
                    </div>
                  </div>
                  <textarea
                    class="flex-1 w-full rounded-lg text-[11px] font-mono p-2"
                    style={{
                      "border": "1px solid var(--color-border-primary)",
                      "background-color": "var(--color-bg-card)",
                      "color": "var(--color-text-primary)",
                    }}
                    readonly
                    value={logs()}
                  />
                </div>
              </Match>
            </Switch>
          </div>

          {/* Remove Database button at bottom right */}
          <div class="px-4 pb-4 pt-2 border-t border-gray-200 dark:border-gray-800 flex justify-end">
            <button
              class="px-3 py-2 text-sm bg-red-50 text-red-700 border border-red-200 rounded-md hover:bg-red-100 disabled:opacity-50"
              disabled={isClearing() || loading() || !className()}
              onClick={() => void handleRemoveDatabase()}
            >
              {isClearing() ? "Removing..." : "Remove Database"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


