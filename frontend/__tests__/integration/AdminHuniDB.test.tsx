import { render } from "@solidjs/testing-library";
import AdminHuniDB from "../../components/admin/AdminHuniDB";

describe("AdminHuniDB", () => {
  it("renders without crashing", () => {
    const { getByText } = render(() => <AdminHuniDB />);
    // Basic sanity check for header text
    getByText("HuniDB Administration");
  });
});


