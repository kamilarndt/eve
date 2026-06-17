import { eveChannel } from "eve/channels/eve";
import type { AuthFn } from "eve/channels/auth";

const evalUserAuth: AuthFn<Request> = () => ({
  attributes: {},
  authenticator: "e2e-eval",
  issuer: "e2e-eval",
  principalId: "eval-user",
  principalType: "user",
});

export default eveChannel({
  auth: evalUserAuth,
});
