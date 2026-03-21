import { createSignal, onMount, Show } from "solid-js";
import { logPageLoad } from "../utils/logging";
import { info } from "../utils/console";
import AdminSidebar from "../components/admin/AdminSidebar";
import AdminUsers from "../components/admin/AdminUsers";
import AdminActivity from "../components/admin/AdminActivity";
import AdminLogs from "../components/admin/AdminLogs";
import AdminStreaming from "../components/admin/AdminStreaming";
import AdminScriptExecution from "../components/admin/AdminScriptExecution";
import AdminHuniDB from "../components/admin/AdminHuniDB";
import AdminDatabase from "../components/admin/AdminDatabase";

type AdminMenu = "users" | "activity" | "logs" | "streaming" | "script-execution" | "hunidb" | "database";

export default function Admin() {
  const [selectedMenu, setSelectedMenu] = createSignal<AdminMenu>("users");

  const handleMenuChange = (menuName: AdminMenu) => {
    setSelectedMenu(menuName);
  };

  onMount(async () => {
    info('[Admin] Page mounting...');
    const startTime = Date.now();
    await logPageLoad('Admin.tsx', 'Admin Page');
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(2);
    info(`[Admin] Page mounted in ${elapsed}s, default menu: ${selectedMenu()}`);
  });

  return (
    <div class="admin-page-container">
      <AdminSidebar onMenuChange={handleMenuChange} />
      <div class="admin-content">
        <Show when={selectedMenu() === "users"}>
          <AdminUsers />
        </Show>
        <Show when={selectedMenu() === "activity"}>
          <AdminActivity />
        </Show>
        <Show when={selectedMenu() === "logs"}>
          <AdminLogs />
        </Show>
        <Show when={selectedMenu() === "streaming"}>
          <AdminStreaming />
        </Show>
        <Show when={selectedMenu() === "script-execution"}>
          <AdminScriptExecution />
        </Show>
        <Show when={selectedMenu() === "hunidb"}>
          <AdminHuniDB />
        </Show>
        <Show when={selectedMenu() === "database"}>
          <AdminDatabase />
        </Show>
      </div>
    </div>
  );
}

