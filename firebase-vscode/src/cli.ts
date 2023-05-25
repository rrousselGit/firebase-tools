import {
  getAllAccounts,
  getGlobalDefaultAccount,
  loginGoogle,
  setGlobalDefaultAccount,
} from "../../src/auth";
import { logoutAction } from "../../src/commands/logout";
import { hostingChannelDeployAction } from "../../src/commands/hosting-channel-deploy";
import { listFirebaseProjects } from "../../src/management/projects";
import { requireAuth } from "../../src/requireAuth";
import { deploy } from "../../src/deploy";
import { FirebaseConfig } from "../../src/firebaseConfig";
import { FirebaseRC } from "../../src/firebaserc";
import { getDefaultHostingSite } from "../../src/getDefaultHostingSite";
import { HostingSingle } from "./firebaseConfig";
import { initAction } from "../../src/commands/init";
import { Account, User } from "../../src/types/auth";
import { Options } from "../../src/options";
import { currentOptions, getCommandOptions } from "./options";
import { setInquirerOptions } from "./stubs/inquirer-stub";
import * as vscode from "vscode";
import { ServiceAccount } from "../common/types";
import { listChannels } from "../../src/hosting/api";
import { ChannelWithId } from "./messaging/types";
import { setEnabled } from "../../src/experiments";
import { logger } from "../../src/logger";

/**
 * Wrap the CLI's requireAuth() which is normally run before every command
 * requiring user to be logged in. The CLI automatically supplies it with
 * account info if found in configstore so we need to fill that part in.
 */
async function requireAuthWrapper(showError: boolean = true) {
  // Try to get global default from configstore. For some reason this is
  // often overwritten when restarting the extension.
  let account = getGlobalDefaultAccount();
  if (!account) {
    // If nothing in configstore top level, grab the first "additionalAccount"
    const accounts = getAllAccounts();
    if (accounts.length > 0) {
      account = accounts[0];
      setGlobalDefaultAccount(account);
    }
  }
  // If account is still null, `requireAuth()` will use google-auth-library
  // to look for the service account hopefully.
  try {
    const commandOptions = await getCommandOptions(undefined, {
      ...currentOptions,
      ...account,
    });
    await requireAuth(commandOptions);
  } catch (e) {
    logger.error('requireAuth error', e.original || e);
    if (showError) {
      vscode.window.showErrorMessage("Not logged in", {
        modal: true,
        detail: `Log in by clicking "Sign in with Google" in the sidebar.`,
      });
    }
    return false;
  }
  // No accounts but no error on requireAuth means it's a service account
  // (or glogin - edge case)
  return true;
}

export async function getAccounts(): Promise<Array<Account | ServiceAccount>> {
  // Get Firebase login accounts
  const accounts: Array<Account | ServiceAccount> = getAllAccounts();
  // Get other accounts (assuming service account for now, could also be glogin)
  const otherAuthExists = await requireAuthWrapper(false);
  if (otherAuthExists) {
    accounts.push({
      user: { email: "service_account", type: "service_account" },
    });
  }
  return accounts;
}

export async function getChannels(firebaseJSON: FirebaseConfig): Promise<ChannelWithId[]> {
  if (!firebaseJSON) {
    return [];
  }
  await requireAuthWrapper();
  const options = { ...currentOptions };
  if (!options.project) {
    return [];
  }
  // TODO: handle multiple hosting configs
  if (!(firebaseJSON.hosting as HostingSingle).site) {
    (firebaseJSON.hosting as HostingSingle).site =
      await getDefaultHostingSite(options);
  }
  const channels = await listChannels(options.project, (firebaseJSON.hosting as HostingSingle).site);

  return channels.map(channel => ({...channel, id: channel.name.split("/").pop()}));
}

export async function logoutUser(email: string): Promise<void> {
  await logoutAction(email, {} as Options);
}

/**
 * Login with standard Firebase login
 */
export async function login() {
  const userCredentials = await loginGoogle(true);
  setGlobalDefaultAccount(userCredentials as Account);
  return userCredentials as { user: User };
}

export async function listProjects() {
  await requireAuthWrapper();
  return listFirebaseProjects();
}

export async function initHosting(options: { spa: boolean; public: string }) {
  await requireAuthWrapper();
  let webFrameworksOptions = {};
  if (process.env.MONOSPACE_ENV) {
    // TODO: Also allow VS Code users to enable this manually with a UI
    setEnabled('webframeworks', true);
    webFrameworksOptions = {
      // Should use auto-discovered framework
      useDiscoveredFramework: true,
      // Should set up a new framework - do not do this on Monospace
      useWebFrameworks: false
    };
  }
  const commandOptions = await getCommandOptions(undefined, currentOptions);
  setInquirerOptions({
    ...commandOptions,
    ...options,
    ...webFrameworksOptions,
    // False for now, we can let the user decide if needed
    github: false
  });
  await initAction("hosting", commandOptions);
}

export async function deployToHosting(
  firebaseJSON: FirebaseConfig,
  firebaseRC: FirebaseRC,
  deployTarget: string
) {
  if (!(await requireAuthWrapper())) {
    return { success: false, hostingUrl: "", consoleUrl: "" };
  }

  // TODO: throw if it doesn't find firebaseJSON or the hosting field
  // const projects = await listFirebaseProjects();
  // const currentProject = projects.find(project => project.projectId === firebaseRC.projects?.default);
  try {
    const options = { ...currentOptions };
    // TODO: handle multiple hosting configs
    if (!(firebaseJSON.hosting as HostingSingle).site) {
      (firebaseJSON.hosting as HostingSingle).site =
        await getDefaultHostingSite(options);
    }
    const commandOptions = await getCommandOptions(firebaseJSON, options);
    if (deployTarget === 'live') {
      await deploy(["hosting"], commandOptions);
    } else {
      await hostingChannelDeployAction(deployTarget, commandOptions);
    }
  } catch (e) {
    logger.error(e);
    return { success: false, hostingUrl: "", consoleUrl: "" };
  }
  return { success: true, hostingUrl: "", consoleUrl: "" };
}