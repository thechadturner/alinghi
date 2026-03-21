import { createSignal, onMount, For } from "solid-js";
import { Portal } from "solid-js/web";
import { getData, postData, deleteData } from "../../utils/global";
import { persistantStore } from "../../store/persistantStore";
import { themeStore } from "../../store/themeStore";
import { user } from "../../store/userStore";

import { apiEndpoints } from "@config/env";
import { error as logError, debug } from "../../utils/console";
const { selectedProjectId, selectedClassName, selectedDatasetId, selectedDate } = persistantStore;

interface Page {
  page_name: string;
  selected: boolean;
}

interface PagesProps {
  setUpdateMenus: (value: boolean) => void;
  setShowModal: (value: boolean) => void;
}

const Pages = (props: PagesProps) => {
  const [pages, setPages] = createSignal<Page[]>([]);


  const fetchPages = async (): Promise<void> => {
    try {
      const controller = new AbortController();
      // Determine page type based on current context
      let pageType;
      if (selectedDatasetId() > 0) {
        pageType = 'dataset/explore';
      } else if (selectedDate()) {
        pageType = 'day/explore';
      } else {
        pageType = 'project/explore';
      }
      
      const currentUser = user();
      if (!currentUser?.user_id) {
        logError("User not available or user_id is missing");
        setPages([]);
        return;
      }
      const url = `${apiEndpoints.app.pages}/selection?class_name=${encodeURIComponent(selectedClassName())}&project_id=${encodeURIComponent(selectedProjectId())}&user_id=${encodeURIComponent(currentUser.user_id)}&page_type=${pageType}`;
      const response = await getData(url, controller.signal)

      if (response.success) {
        setPages(response.data || []);
      } else {
        setPages([]);
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {
        // Request was aborted, ignore
      } else {
        logError("Error fetching pages:", error);
        setPages([]);
      }
    }
  };

  const toggleItem = async (pageName: string, selected: boolean): Promise<void> => {
    // Optimistically update local state
    setPages((prev) =>
      prev.map((page) =>
        page.page_name === pageName ? { ...page, selected: !selected } : page
      )
    );

    // Send update to the server
    try {
      if (selected == false) {
        // Adding a page - use POST /api/users/page
        // Determine page type based on current context
        let pageType;
        if (selectedDatasetId() > 0) {
          pageType = 'dataset/explore';
        } else if (selectedDate()) {
          pageType = 'day/explore';
        } else {
          pageType = 'project/explore';
        }
        
        const currentUser = user();
        if (!currentUser?.user_id) {
          logError("User not available or user_id is missing");
          return;
        }
        const payload = {
          'class_name': selectedClassName(), 
          'project_id': selectedProjectId(),
          'user_id': currentUser.user_id, 
          'page_type': pageType,
          'page_name': pageName
        };
        const controller = new AbortController();
        const response = await postData(apiEndpoints.app.users + '/page', payload, controller.signal);

        if (!response.success) {
          throw new Error("Failed to add page selection");
        } else {
          props.setUpdateMenus(true);
        }
      } else {
        // Removing a page - use DELETE /api/users/page
        let pageType;
        if (selectedDatasetId() > 0) {
          pageType = 'dataset/explore';
        } else if (selectedDate()) {
          pageType = 'day/explore';
        } else {
          pageType = 'project/explore';
        }
        
        const currentUser = user();
        if (!currentUser?.user_id) {
          logError("User not available or user_id is missing");
          return;
        }
        const payload = {
          'class_name': selectedClassName(), 
          'project_id': selectedProjectId(),
          'user_id': currentUser.user_id, 
          'page_type': pageType,
          'page_name': pageName
        };
        const controller = new AbortController();
        const response = await deleteData(apiEndpoints.app.users + '/page', payload, controller.signal);

        if (!response.success) {
          throw new Error("Failed to remove page selection");
        } else {
          props.setUpdateMenus(true);
        }
      }
    } catch (error: any) {
      if (error.name === 'AbortError') {

      } else {
        logError("Error updating selection:", error);

        // Rollback state if update fails
        setPages((prev) =>
          prev.map((page) =>
            page.page_name === pageName ? { ...page, selected: selected } : page
          )
        );
      }
    }
  };

  onMount(fetchPages);


  return (
    <Portal>
      {pages().length > 0 && (
        <div class={`modal ${themeStore.isDark() ? 'dark' : 'light'}`}>
          <div class="modal-dialog">
            <div class="modal-content w-[200px]">
              <div class="modal-header">
                <h5 class="modal-title">Manage Pages</h5>
                <button class="close" onClick={() => {
                  props.setShowModal(false);
                  // Reload the page to ensure all components are in sync with any page changes
                  debug('🔄 Pages: Modal closed, reloading to sync all components');
                  window.location.reload();
                }}>
                  &times;
                </button>
              </div>
              <div class="modal-body">
                <For each={pages()}>
                  {(page) => (
                    <div data-key={page.page_name} class="page-item">
                      <label class="page-label">
                        <input class="page-checkbox mr-2 mt-2"
                          type="checkbox"
                          checked={page.selected}
                          onChange={() => toggleItem(page.page_name, page.selected)}
                        />
                        <span class="page-name">{page.page_name}</span>
                      </label>
                    </div>
                  )}
                </For>
              </div>
              <div class="modal-footer">
                <button class="btn btn-secondary px-4 py-2 ml-2" onClick={() => {
                  props.setShowModal(false);
                  // Reload the page to ensure all components are in sync with any page changes
                  debug('🔄 Pages: Save clicked, reloading to sync all components');
                  window.location.reload();
                }}>
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </Portal>
  );
};

export default Pages;

