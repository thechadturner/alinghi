import { onMount, onCleanup } from "solid-js";
import { logPageLoad } from "../utils/logging";
import BackButton from "../components/buttons/BackButton";
import { setNoRobotsMetaTags } from "../utils/metaTags";

export default function TermsOfService() {
  onMount(() => {
    logPageLoad('TermsOfService.tsx', 'Terms of Service Page');
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
        }
        .legal-content-container {
          max-width: 900px;
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
            <h1 class="login-title">Terms of Service</h1>
            <p class="login-subtitle">Last updated: January 2025</p>
          </div>
        </div>
        
        <div style="text-align: left; color: var(--text-color); line-height: 1.6;">
          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">1. Acceptance of Terms</h2>
            <p style="margin-bottom: 1rem;">
              By accessing or using RACESIGHT ("the Service"), you agree to be bound by these Terms of Service ("Terms"). If you disagree with any part of these terms, you may not access the Service.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">2. Description of Service</h2>
            <p style="margin-bottom: 1rem;">
             RACESIGHT is a collaborative data analysis platform that provides visualization tools, real-time collaboration features, and data processing capabilities. The Service allows users to upload, analyze, and share data through various visualization formats.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">3. User Accounts</h2>
            <h3 style="font-size: 1.2rem; font-weight: 600; margin-top: 1rem; margin-bottom: 0.5rem;">3.1 Account Creation</h3>
            <p style="margin-bottom: 1rem;">
              To use certain features of the Service, you must create an account. You agree to:
            </p>
            <ul style="margin-left: 1.5rem; margin-bottom: 1rem;">
              <li>Provide accurate, current, and complete information</li>
              <li>Maintain and update your account information</li>
              <li>Maintain the security of your account credentials</li>
              <li>Accept responsibility for all activities under your account</li>
            </ul>

            <h3 style="font-size: 1.2rem; font-weight: 600; margin-top: 1rem; margin-bottom: 0.5rem;">3.2 Account Security</h3>
            <p style="margin-bottom: 1rem;">
              You are responsible for maintaining the confidentiality of your account credentials and for all activities that occur under your account.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">4. Acceptable Use</h2>
            <p style="margin-bottom: 1rem;">You agree not to:</p>
            <ul style="margin-left: 1.5rem; margin-bottom: 1rem;">
              <li>Use the Service for any illegal purpose or in violation of any laws</li>
              <li>Upload, transmit, or share any content that is harmful, offensive, or violates others' rights</li>
              <li>Attempt to gain unauthorized access to the Service or other users' accounts</li>
              <li>Interfere with or disrupt the Service or servers</li>
              <li>Use automated systems to access the Service without permission</li>
              <li>Share your account credentials with others</li>
              <li>Reverse engineer, decompile, or disassemble any part of the Service</li>
            </ul>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">5. User Content and Data</h2>
            <h3 style="font-size: 1.2rem; font-weight: 600; margin-top: 1rem; margin-bottom: 0.5rem;">5.1 Ownership</h3>
            <p style="margin-bottom: 1rem;">
              You retain ownership of all data and content you upload to the Service. By uploading content, you grant us a license to store, process, and display that content as necessary to provide the Service.
            </p>

            <h3 style="font-size: 1.2rem; font-weight: 600; margin-top: 1rem; margin-bottom: 0.5rem;">5.2 Data Responsibility</h3>
            <p style="margin-bottom: 1rem;">
              You are solely responsible for the data you upload and share. You represent that you have the right to upload and share such data and that it does not violate any third-party rights.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">6. Intellectual Property</h2>
            <p style="margin-bottom: 1rem;">
              The Service, including its original content, features, and functionality, is owned by RACESIGHT and is protected by international copyright, trademark, and other intellectual property laws.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">7. Service Availability</h2>
            <p style="margin-bottom: 1rem;">
              We strive to provide reliable service but do not guarantee that the Service will be available at all times. We reserve the right to modify, suspend, or discontinue the Service at any time with or without notice.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">8. Limitation of Liability</h2>
            <p style="margin-bottom: 1rem;">
              To the maximum extent permitted by law, RACESIGHT shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of profits or revenues, whether incurred directly or indirectly, or any loss of data, use, goodwill, or other intangible losses.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">9. Termination</h2>
            <p style="margin-bottom: 1rem;">
              We may terminate or suspend your account and access to the Service immediately, without prior notice, for conduct that we believe violates these Terms or is harmful to other users, us, or third parties.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">10. Changes to Terms</h2>
            <p style="margin-bottom: 1rem;">
              We reserve the right to modify these Terms at any time. We will notify users of any material changes by posting the updated Terms on this page and updating the "Last updated" date. Your continued use of the Service after such changes constitutes acceptance of the new Terms.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">11. Governing Law</h2>
            <p style="margin-bottom: 1rem;">
              These Terms shall be governed by and construed in accordance with applicable laws, without regard to conflict of law provisions.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">12. Contact Information</h2>
            <p style="margin-bottom: 1rem;">
              If you have any questions about these Terms of Service, please contact us:
            </p>
            <p style="margin-bottom: 1rem;">
              <a href="/contact" style="color: var(--primary-color); text-decoration: underline;">Contact Us</a>
            </p>
          </section>
        </div>
        </div>
      </div>
    </>
  );
}

