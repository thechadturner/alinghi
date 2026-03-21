import { useNavigate } from "@solidjs/router";
import { step, setStep, maxStep, proceed, setProceed } from "../../store/globalStore";
import { persistantStore } from "../../store/persistantStore";

const { selectedClassName } = persistantStore;

export default function BackNextButtons(props) {
  const { onFinalize } = props || {};
  const navigate = useNavigate();

  const handleNext = () => {
    if (!proceed()) return;
    if (step() === maxStep() && typeof onFinalize === 'function') {
      onFinalize();
      return;
    }
    if (step() < maxStep()) {
      setStep(step() + 1);
      setProceed(false);

      if (step() == 6) {
        const className = selectedClassName() || 'gp50';
        navigate(`/dataset-info/${className}`, { state: { state: "Save" } });
      }
    }
  };

  const handleBack = () => {
    if (step() > 1) {
      setStep(step() - 1);
    }
  };

  return (
    <div class="back-next-buttons">
      <button type="button" class="back-button" onClick={handleBack} disabled={step() < 2}>
        ← Back
      </button>
      <button type="button" class="next-button" onClick={handleNext} disabled={!proceed()}>
        {step() === maxStep() ? "Finalize" : "Next →"}
      </button>
    </div>
  );
}
