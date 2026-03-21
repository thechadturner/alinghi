import { useNavigate } from "@solidjs/router";

export default function BackButton(props) {
    const navigate = useNavigate();
    const to = props?.to || "/dashboard";
    const label = props?.label || (to === "/" ? "← Back to Home" : "← Back to Dashboard");
    
    const handleBackClick = () => {
        // Use router navigation instead of full page reload to prevent freezing
        navigate(to, { replace: true });
    };
    
    return (
        <div class="back-only-button">
            <button type="button" onClick={handleBackClick} class="back-link">{label}</button>
        </div>
    );
  }
