import { onMount, onCleanup } from "solid-js";
import { logPageLoad } from "../utils/logging";
import BackButton from "../components/buttons/BackButton";
import { setNoRobotsMetaTags } from "../utils/metaTags";

export default function PrivacyPolicy() {
  onMount(() => {
    logPageLoad('PrivacyPolicy.tsx', 'Privacy Policy Page');
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
            <h1 class="login-title">Privacy Policy</h1>
            <p class="login-subtitle">Last updated: January 2025</p>
          </div>
        </div>
        
        <div style="text-align: left; color: var(--text-color); line-height: 1.6;">
          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">1. Introduction</h2>
            <p style="margin-bottom: 1rem;">
              RACESIGHT ("we", "our", or "us") is committed to protecting your privacy. This Privacy Policy explains how we collect, use, disclose, and safeguard your information when you use our collaborative data analysis platform.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">2. Information We Collect</h2>
            <h3 style="font-size: 1.2rem; font-weight: 600; margin-top: 1rem; margin-bottom: 0.5rem;">2.1 Personal Information</h3>
            <p style="margin-bottom: 1rem;">
              We collect information that you provide directly to us, including:
            </p>
            <ul style="margin-left: 1.5rem; margin-bottom: 1rem;">
              <li>Name and contact information (email address)</li>
              <li>Account credentials and authentication data</li>
              <li>User preferences and settings</li>
            </ul>

            <h3 style="font-size: 1.2rem; font-weight: 600; margin-top: 1rem; margin-bottom: 0.5rem;">2.2 Usage Data</h3>
            <p style="margin-bottom: 1rem;">
              We automatically collect information about how you interact with our platform, including:
            </p>
            <ul style="margin-left: 1.5rem; margin-bottom: 1rem;">
              <li>Project and dataset access logs</li>
              <li>Feature usage and interaction patterns</li>
              <li>Technical information (browser type, device information, public IP address)</li>
            </ul>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">3. How We Use Your Information</h2>
            <p style="margin-bottom: 1rem;">We use the information we collect to:</p>
            <ul style="margin-left: 1.5rem; margin-bottom: 1rem;">
              <li>Provide, maintain, and improve our services</li>
              <li>Authenticate users and manage accounts</li>
              <li>Enable collaboration features and data sharing</li>
              <li>Respond to your inquiries and provide support</li>
              <li>Ensure security and prevent fraud</li>
              <li>Comply with legal obligations</li>
            </ul>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">4. Data Storage and Security</h2>
            <p style="margin-bottom: 1rem;">
              We implement appropriate technical and organizational measures to protect your personal information. Your data is stored securely using encryption and access controls. However, no method of transmission over the Internet is 100% secure.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">5. Data Sharing and Disclosure</h2>
            <p style="margin-bottom: 1rem;">
              We do not sell your personal information. We may share your information only in the following circumstances:
            </p>
            <ul style="margin-left: 1.5rem; margin-bottom: 1rem;">
              <li>With your explicit consent</li>
              <li>To comply with legal obligations</li>
              <li>To protect our rights and safety</li>
              <li>With service providers who assist in operating our platform (under strict confidentiality agreements)</li>
            </ul>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">6. Your Rights (GDPR)</h2>
            <p style="margin-bottom: 1rem;">
              If you are located in the European Economic Area (EEA), you have certain data protection rights:
            </p>
            <ul style="margin-left: 1.5rem; margin-bottom: 1rem;">
              <li><strong>Right to access:</strong> Request copies of your personal data</li>
              <li><strong>Right to rectification:</strong> Request correction of inaccurate data</li>
              <li><strong>Right to erasure:</strong> Request deletion of your personal data</li>
              <li><strong>Right to restrict processing:</strong> Request limitation of how we process your data</li>
              <li><strong>Right to data portability:</strong> Request transfer of your data to another service</li>
              <li><strong>Right to object:</strong> Object to our processing of your personal data</li>
            </ul>
            <p style="margin-bottom: 1rem;">
              To exercise these rights, please contact us using the information provided in the Contact section.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">7. Cookies</h2>
            <p style="margin-bottom: 1rem;">
              We use cookies and similar technologies to maintain your session, remember preferences, and improve your experience. For more information, please see our <a href="/cookie-policy" style="color: var(--primary-color); text-decoration: underline;">Cookie Policy</a>.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">8. Data Retention</h2>
            <p style="margin-bottom: 1rem;">
              We retain your personal information for as long as necessary to provide our services and comply with legal obligations. When you delete your account, we will delete or anonymize your personal data in accordance with our data retention policies.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">9. Changes to This Privacy Policy</h2>
            <p style="margin-bottom: 1rem;">
              We may update this Privacy Policy from time to time. We will notify you of any changes by posting the new Privacy Policy on this page and updating the "Last updated" date.
            </p>
          </section>

          <section style="margin-bottom: 2rem;">
            <h2 style="font-size: 1.5rem; font-weight: 600; margin-bottom: 1rem; color: var(--text-color);">10. Contact Us</h2>
            <p style="margin-bottom: 1rem;">
              If you have any questions about this Privacy Policy or wish to exercise your rights, please contact us at:
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

