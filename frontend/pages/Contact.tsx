import { onMount, onCleanup } from "solid-js";
import { logPageLoad } from "../utils/logging";
import BackButton from "../components/buttons/BackButton";
import { setNoRobotsMetaTags } from "../utils/metaTags";

export default function Contact() {
  onMount(() => {
    logPageLoad('Contact.tsx', 'Contact Page');
    const cleanup = setNoRobotsMetaTags();
    onCleanup(() => cleanup());
  });

  return (
    <>
      <style>{`
        .legal-page-container {
          position: fixed;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          overflow-y: auto;
          overflow-x: hidden;
          background: var(--color-bg-secondary);
          padding: 20px;
          box-sizing: border-box;
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
        }
        .legal-content-container {
          max-width: 700px;
          margin: 0 auto;
          padding: 2rem;
          background: var(--color-bg-card);
          backdrop-filter: blur(20px);
          border-radius: 20px;
          box-shadow: 0 20px 40px var(--color-shadow-md);
          border: 1px solid var(--color-border-primary);
          position: relative;
          margin-bottom: 100px;
        }
        .legal-page-container .back-only-button {
          z-index: 10000 !important;
        }
      `}</style>
      <BackButton to="/" label="← Back to Home" />
      <div class="legal-page-container">
        <div class="legal-content-container">
        <div class="login-header">
          <div class="logo-section">
            <div class="logo-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2L2 7L12 12L22 7L12 2Z" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M2 17L12 22L22 17" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                <path d="M2 12L12 17L22 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <h1 class="login-title">Contact Us</h1>
            <p class="login-subtitle">E-Mail:  support@RACESIGHT.cloud</p>
          </div>
        </div>
        </div>
      </div>
    </>
  );
}

