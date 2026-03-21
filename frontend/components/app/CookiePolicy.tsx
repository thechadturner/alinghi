import { useNavigate } from "@solidjs/router";
import { isAccepted, setIsAccepted, setCookiePolicy } from "../../store/userStore"; 

export default function CookiePolicy() {
  const navigate = useNavigate();

  const handleAccept = () => {
    setCookiePolicy(true)
    setIsAccepted(true);
    localStorage.setItem("cookiesAccepted", "true");
  };

  const handleReject = () => {
    setCookiePolicy(true)
    setIsAccepted(false);
    navigate(`/index`);
    localStorage.removeItem("cookiesAccepted");
  };

  return (
    !isAccepted() && (
      <div class="cookie-policy">
        <p>This site requires the use of cookies for authentication and to improve your experience. Accept cookies to continue...</p>
        <button onClick={handleAccept}>Accept</button>
        <button onClick={handleReject}>Reject</button>
      </div>
    )
  );
}
