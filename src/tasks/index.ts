import { removeDups } from "./removeDups";
import { countTxnWithArbiterFee } from "./countTxnWithArbiterFee";
import { config as dotEnvConfig } from "dotenv";

dotEnvConfig();

// removeDups();

// updateStatus();

countTxnWithArbiterFee();
