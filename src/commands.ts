/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Ben Crowl. All rights reserved.
 *  Original Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Uri, commands, scm, Disposable, window, workspace, QuickPickItem, OutputChannel, Range, WorkspaceEdit, Position, LineChange, SourceControlResourceState, SourceControl } from "vscode";
import { Ref, RefType, Hg, Commit, HgError, HgErrorCodes, PushOptions, IMergeResult } from "./hg";
import { Model, Resource, Status, CommitOptions, CommitScope, MergeStatus } from "./model";
import * as path from 'path';
import * as os from 'os';
import * as nls from 'vscode-nls';
import { WorkingDirectoryGroup, StagingGroup, MergeGroup, UntrackedGroup, ConflictGroup } from "./resourceGroups";
import { interaction, BranchExistsAction, WarnScenario } from "./interaction";
import * as vscode from "vscode";
import * as fs from "fs";

const localize = nls.loadMessageBundle();

interface Command {
	commandId: string;
	key: string;
	method: Function;
	skipModelCheck: boolean;
}

const Commands: Command[] = [];

function command(commandId: string, skipModelCheck = false): Function {
	return (target: any, key: string, descriptor: any) => {
		if (!(typeof descriptor.value === 'function')) {
			throw new Error('not supported');
		}

		Commands.push({ commandId, key, method: descriptor.value, skipModelCheck });
	};
}

export class CommandCenter {

	private model: Model;
	private disposables: Disposable[];

	constructor(
		private hg: Hg,
		model: Model | undefined,
		private outputChannel: OutputChannel
	) {
		if (model) {
			this.model = model;
		}

		this.disposables = Commands
			.map(({ commandId, key, method, skipModelCheck }) => {
				const command = this.createCommand(commandId, key, method, skipModelCheck);
				return commands.registerCommand(commandId, command);
			});
	}

	@command('hg.refresh')
	async refresh(): Promise<void> {
		await this.model.status();
	}

	@command('hg.openResource')
	async openResource(resource: Resource): Promise<void> {
		await this._openResource(resource);
	}

	private async _openResource(resource: Resource): Promise<void> {
		const left = this.getLeftResource(resource);
		const right = this.getRightResource(resource);
		const title = this.getTitle(resource);

		if (!right) {
			// TODO
			console.error('oh no');
			return;
		}

		if (!left) {
			return await commands.executeCommand<void>('vscode.open', right);
		}

		return await commands.executeCommand<void>('vscode.diff', left, right, title);
	}

	private getLeftResource(resource: Resource): Uri | undefined {
		switch (resource.status) {
			case Status.MODIFIED:
				return resource.original.with({ scheme: 'hg', query: '.' });

			case Status.RENAMED:
				if (resource.renameResourceUri) {
					return resource.original.with({ scheme: 'hg', query: '.' })
				}
				return undefined;

			case Status.ADDED:
			case Status.IGNORED:
			case Status.DELETED:
			case Status.MISSING:
			case Status.UNTRACKED:
			case Status.CLEAN:
				return undefined;
		}
	}

	private getRightResource(resource: Resource): Uri | undefined {
		if (resource.mergeStatus === MergeStatus.UNRESOLVED &&
			resource.status !== Status.MISSING &&
			resource.status !== Status.DELETED) {
			return resource.resourceUri.with({ scheme: 'hg', query: 'p2()' });
		}

		switch (resource.status) {
			case Status.DELETED:
				return resource.resourceUri.with({ scheme: 'hg', query: '.' });

			case Status.ADDED:
			case Status.IGNORED:
			case Status.MODIFIED:
			case Status.RENAMED:
			case Status.UNTRACKED:
			case Status.CLEAN:
				return resource.resourceUri;

			case Status.MISSING:
				return undefined;	
		}
	}

	private getTitle(resource: Resource): string {
		const basename = path.basename(resource.resourceUri.fsPath);
		if (resource.mergeStatus === MergeStatus.UNRESOLVED &&
			resource.status !== Status.MISSING &&
			resource.status !== Status.DELETED) {
			return `${basename} (local <-> other)`
		}

		switch (resource.status) {
			case Status.MODIFIED:
			case Status.ADDED:
				return `${basename} (Working Directory)`;

			case Status.RENAMED:
				return `${basename} (Renamed)`;

			case Status.DELETED:
				return `${basename} (Deleted)`;
		}

		return '';
	}

	@command('hg.clone', true)
	async clone(): Promise<void> {
		const url = await interaction.inputRepoUrl();
		if (!url) {
			return;
		}

		const parentPath = await interaction.inputCloneParentPath();
		if (!parentPath) {
			return;
		}

		const clonePromise = this.hg.clone(url, parentPath);
		interaction.statusCloning(clonePromise);

		try {
			const repositoryPath = await clonePromise;
			const openClonedRepo = await interaction.promptOpenClonedRepo();
			if (openClonedRepo) {
				commands.executeCommand('vscode.openFolder', Uri.file(repositoryPath));
			}
		}
		catch (err) {
			throw err;
		}
	}

	@command('hg.init')
	async init(): Promise<void> {
		await this.model.init();

	}
	@command('hg.openhgrc')
	async openhgrc(): Promise<void> {
		let hgrcPath = await this.model.hgrcPathIfExists();
		if (!hgrcPath) {
			hgrcPath = await this.model.createHgrc();
		}

		const hgrcUri = new vscode.Uri().with({
			scheme: 'file',
			path: hgrcPath
		})
		commands.executeCommand("vscode.open", hgrcUri);
	}

	@command('hg.openFile')
	async openFile(resource?: Resource): Promise<void> {
		if (!resource) {
			return;
		}

		return await commands.executeCommand<void>('vscode.open', resource.resourceUri);
	}

	@command('hg.openChange')
	async openChange(resource?: Resource): Promise<void> {
		if (!resource) {
			return;
		}

		return await this._openResource(resource);
	}

	@command('hg.openFileFromUri')
	async openFileFromUri(uri?: Uri): Promise<void> {
		const resource = this.getSCMResource(uri);

		if (!resource) {
			return;
		}

		return await commands.executeCommand<void>('vscode.open', resource.resourceUri);
	}

	@command('hg.openChangeFromUri')
	async openChangeFromUri(uri?: Uri): Promise<void> {
		const resource = this.getSCMResource(uri);

		if (!resource) {
			return;
		}

		return await this._openResource(resource);
	}

	@command('hg.addAll')
	async addAll(): Promise<void> {
		return await this.model.add();
	}

	@command('hg.add')
	async add(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			const resource = this.getSCMResource();

			if (!resource) {
				return;
			}

			resourceStates = [resource];
		}

		const resources = resourceStates
			.filter(s => s instanceof Resource && s.resourceGroup instanceof UntrackedGroup) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.add(...resources);
	}

	@command('hg.forget')
	async forget(...resourceStates: SourceControlResourceState[]): Promise<void> {
		const resources = resourceStates
			.filter(s => s instanceof Resource && s.resourceGroup instanceof WorkingDirectoryGroup) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.forget(...resources);
	}

	@command('hg.stage')
	async stage(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			const resource = this.getSCMResource();

			if (!resource) {
				return;
			}

			resourceStates = [resource];
		}

		const resources = resourceStates
			.filter(s => s instanceof Resource && (s.resourceGroup instanceof WorkingDirectoryGroup || s.resourceGroup instanceof MergeGroup)) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.stage(...resources);
	}

	@command('hg.stageAll')
	async stageAll(): Promise<void> {
		return await this.model.stage();
	}

	@command('hg.markResolved')
	async markResolved(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			return;
		}

		const resources = resourceStates.filter(s =>
			s instanceof Resource &&
			s.resourceGroup instanceof ConflictGroup &&
			s.mergeStatus === MergeStatus.UNRESOLVED) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.resolve(resources, { mark: true });
	}

	@command('hg.resolveAgain')
	async resolve(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			return;
		}

		const resources = resourceStates.filter(s =>
			s instanceof Resource &&
			s.resourceGroup instanceof ConflictGroup &&
			s.mergeStatus === MergeStatus.UNRESOLVED) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.resolve(resources);
	}

	@command('hg.unresolve')
	async unresolve(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			return;
		}

		const resources = resourceStates.filter(s =>
			s instanceof Resource &&
			s.resourceGroup instanceof MergeGroup &&
			s.mergeStatus !== MergeStatus.UNRESOLVED) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.unresolve(resources);
	}

	@command('hg.unstage')
	async unstage(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			const resource = this.getSCMResource();

			if (!resource) {
				return;
			}

			resourceStates = [resource];
		}

		const resources = resourceStates.filter(s =>
			s instanceof Resource &&
			s.resourceGroup instanceof StagingGroup) as Resource[];

		if (!resources.length) {
			return;
		}

		return await this.model.unstage(...resources);
	}

	@command('hg.unstageAll')
	async unstageAll(): Promise<void> {
		return await this.model.unstage();
	}

	@command('hg.clean')
	async clean(...resourceStates: SourceControlResourceState[]): Promise<void> {
		if (resourceStates.length === 0) {
			const resource = this.getSCMResource();

			if (!resource) {
				return;
			}

			resourceStates = [resource];
		}

		const resources = resourceStates.filter(s =>
			s instanceof Resource &&
			s.isDirtyStatus) as Resource[];

		if (!resources.length) {
			return;
		}

		const resourcesToConfirm: Resource[] = resources.filter(s => s.status !== Status.ADDED);
		if (resourcesToConfirm.length > 0) {
			const confirmed = await interaction.confirmDiscardChanges(resourcesToConfirm);
			if (!confirmed) {
				return;
			}
		}

		await this.model.cleanOrUpdate(...resources);
	}

	@command('hg.cleanAll')
	async cleanAll(): Promise<void> {
		if (await interaction.confirmDiscardAllChanges()) {
			const resources = this.model.workingDirectoryGroup.resources;
			await this.model.cleanOrUpdate(...resources);
		}
	}

	private async smartCommit(getCommitMessage: () => Promise<string>, opts?: CommitOptions): Promise<boolean> {
		// validate no conflicts
		const numConflictResources = this.model.conflictGroup.resources.length;
		if (numConflictResources > 0) {
			interaction.warnResolveConflicts();
			return false;
		}

		const isMergeCommit = this.model.repoStatus && this.model.repoStatus.isMerge;
		if (isMergeCommit) {
			// merge-commit
			opts = { scope: CommitScope.ALL };
		}
		else {
			// validate non-merge commit
			const numWorkingResources = this.model.workingDirectoryGroup.resources.length;
			const numStagingResources = this.model.stagingGroup.resources.length;
			if (!opts || opts.scope === undefined) {
				if (numStagingResources > 0) {
					opts = {
						scope: CommitScope.STAGED_CHANGES
					};
				}
				else {
					opts = {
						scope: CommitScope.CHANGES
					};
				}
			}

			if ((numWorkingResources === 0 && numStagingResources === 0) // no changes
				|| (opts && opts.scope === CommitScope.STAGED_CHANGES && numStagingResources === 0) // no staged changes
				|| (opts && opts.scope === CommitScope.CHANGES && numWorkingResources === 0) // no working directory changes
			) {
				interaction.informNoChangesToCommit();
				return false;
			}
		}

		const message = await getCommitMessage();

		if (!message) {
			// TODO@joao: show modal dialog to confirm empty message commit
			return false;
		}

		await this.model.commit(message, opts);

		return true;
	}

	private async commitWithAnyInput(opts?: CommitOptions): Promise<void> {
		const message = scm.inputBox.value;
		const didCommit = await this.smartCommit(() => interaction.inputCommitMessage(message), opts);

		if (message && didCommit) {
			scm.inputBox.value = "";
		}
	}

	@command('hg.commit')
	async commit(): Promise<void> {
		await this.commitWithAnyInput();
	}

	@command('hg.commitWithInput')
	async commitWithInput(): Promise<void> {
		const didCommit = await this.smartCommit(async () => scm.inputBox.value);

		if (didCommit) {
			scm.inputBox.value = "";
		}
	}

	@command('hg.commitStaged')
	async commitStaged(): Promise<void> {
		await this.commitWithAnyInput({ scope: CommitScope.STAGED_CHANGES });
	}

	@command('hg.commitAll')
	async commitAll(): Promise<void> {
		await this.commitWithAnyInput({ scope: CommitScope.ALL_WITH_ADD_REMOVE });
	}

	private focusScm() {
		commands.executeCommand("workbench.view.scm");
	}

	@command('hg.undoRollback')
	async undoRollback(): Promise<void> {
		try {
			// dry-run
			const rollbackDetails = await this.model.rollback(true);
			if (await interaction.confirmRollback(rollbackDetails)) {
				await this.model.rollback();

				if (rollbackDetails.kind === "commit") {
					scm.inputBox.value = rollbackDetails.commitMessage;
					this.focusScm();
				}
			}
		}
		catch (e) {
			if (e instanceof HgError && e.hgErrorCode === HgErrorCodes.NoRollbackInformationAvailable) {
				await interaction.warnNoRollback();
			}
		}
	}


	@command('hg.update')
	async update(): Promise<void> {
		if (await interaction.checkThenWarnOutstandingMerge(this.model, WarnScenario.Update) ||
			await interaction.checkThenWarnUnclean(this.model, WarnScenario.Update)) {
			this.focusScm();
			return;
		}

		const refs = await this.model.getRefs();
		const choice = await interaction.pickBranchOrTag(refs);

		if (choice) {
			await choice.run(this.model);
		}
	}

	@command('hg.branch')
	async branch(): Promise<void> {
		const result = await interaction.inputBranchName();
		if (!result) {
			return;
		}

		const name = result.replace(/^\.|\/\.|\.\.|~|\^|:|\/$|\.lock$|\.lock\/|\\|\*|\s|^\s*$|\.$/g, '-');
		try {
			await this.model.branch(name);
		}
		catch (e) {
			if (e instanceof HgError && e.hgErrorCode === HgErrorCodes.BranchAlreadyExists) {
				const action = await interaction.warnBranchAlreadyExists(name);
				if (action === BranchExistsAction.Reopen) {
					await this.model.branch(name, { allowBranchReuse: true });
				}
				else if (action === BranchExistsAction.UpdateTo) {
					await this.model.update(name);
				}
			}
		}
	}

	@command('hg.pull')
	async pull(): Promise<void> {
		const paths = await this.model.getPaths();

		if (paths.length === 0) {
			interaction.warnNoPaths(false);
			return;
		}

		await this.model.pull();
	}

	private createPushOptions(): PushOptions | undefined {
		const config = workspace.getConfiguration('hg');
		const allowPushNewBranches = config.get<boolean>('allowPushNewBranches') || false;
		return allowPushNewBranches ?
			{ allowPushNewBranches: true } :
			undefined;
	}

	@command('hg.mergeWithLocal')
	async mergeWithLocal() {
		if (await interaction.checkThenWarnOutstandingMerge(this.model, WarnScenario.Merge) ||
			await interaction.checkThenWarnUnclean(this.model, WarnScenario.Merge)) {
			this.focusScm();
			return;
		}

		const otherHeads = await this.model.getHeads({ excludeSelf: true });
		const placeholder = localize('choose head', `Choose head to merge into working directory:`);
		const head = await interaction.pickHead(otherHeads, placeholder);
		if (head) {
			return await this.doMerge(head.hash);
		}
	}

	@command('hg.mergeHeads')
	async mergeHeads() {
		if (await interaction.checkThenWarnOutstandingMerge(this.model, WarnScenario.Merge) ||
			await interaction.checkThenWarnUnclean(this.model, WarnScenario.Merge)) {
			this.focusScm();
			return;
		}

		const { currentBranch } = this.model;
		if (!currentBranch) {
			return;
		}

		const otherBranchHeads = await this.model.getHeads({ branch: currentBranch.name, excludeSelf: true });
		if (otherBranchHeads.length === 0) {
			// 1 head
			interaction.warnMergeOnlyOneHead(currentBranch.name);
			return;
		}
		else if (otherBranchHeads.length === 1) {
			// 2 heads
			const [otherHead] = otherBranchHeads;
			return await this.doMerge(otherHead.hash);
		}
		else {
			// 3+ heads
			const placeHolder = localize('choose branch head', "Branch {0} has {1} heads. Choose which to merge:", currentBranch.name, otherBranchHeads.length + 1);
			const head = await interaction.pickHead(otherBranchHeads, placeHolder);
			if (head) {
				return await this.doMerge(head.hash);
			}
		}
	}

	private async doMerge(revisionOrHash: string) {
		try {
			const result = await this.model.merge(revisionOrHash);

			if (result.unresolvedCount > 0) {
				interaction.warnUnresolvedFiles(result.unresolvedCount);
			}
		}
		catch (e) {
			if (e instanceof HgError && e.hgErrorCode === HgErrorCodes.UntrackedFilesDiffer && e.hgFilenames) {
				interaction.errorUntrackedFilesDiffer(e.hgFilenames);
				return;
			}

			throw e;
		}
	}

	@command('hg.push')
	async push(): Promise<void> {
		const paths = await this.model.getPaths();

		if (paths.length === 0) {
			interaction.warnNoPaths(true);
			return;
		}

		// check for branches with 2+ heads		
		const multiHeadBranchNames = await this.model.getBranchNamesWithMultipleHeads();
		if (multiHeadBranchNames.length === 1) {
			const [branch] = multiHeadBranchNames;
			interaction.warnBranchMultipleHeads(branch);
			return;
		}
		else if (multiHeadBranchNames.length > 1) {
			interaction.warnMultipleBranchMultipleHeads(multiHeadBranchNames);
			return;
		}

		await this.model.push(undefined, this.createPushOptions());
	}

	@command('hg.pushTo')
	async pushTo(): Promise<void> {
		const paths = await this.model.getPaths();

		if (paths.length === 0) {
			interaction.warnNoPaths(true);
			return;
		}

		const chosenPath = await interaction.pickRemotePath(paths);
		if (chosenPath) {
			this.model.push(chosenPath, this.createPushOptions());
		}
	}

	@command('hg.showOutput')
	showOutput(): void {
		this.outputChannel.show();
	}

	@command('hg.fileLog')
	async fileLog(uri?: Uri) {
		if (!uri) {
			if (window.activeTextEditor) {
				uri = window.activeTextEditor.document.uri;
			}

			if (!uri || uri.scheme !== 'file') {
				return;
			}
		}

		const logEntries = await this.model.getLogEntries(uri);
		const logEntry = await interaction.pickLogEntry(logEntries);

		if (logEntry) {
			this.diff(logEntry.commit, uri);
		}
	}

	private async diff(commit: Commit, uri: Uri) {
		const left = uri.with({ scheme: 'hg', query: commit.hash });
		const right = uri;
		const baseName = path.basename(uri.fsPath);
		const title = `${baseName} (#${commit.revision} vs. local)`;

		if (left && right) {
			return await commands.executeCommand<void>('vscode.diff', left, right, title);
		}
	}

	private createCommand(id: string, key: string, method: Function, skipModelCheck: boolean): (...args: any[]) => Promise<any> | undefined {
		const result = (...args) => {
			if (!skipModelCheck && !this.model) {
				interaction.informHgNotSupported();
				return;
			}

			const result = Promise.resolve(method.apply(this, args));

			return result.catch(async err => {
				const openLog = await interaction.errorPromptOpenLog(err);
				if (openLog) {
					this.outputChannel.show();
				}
				else {
					this.focusScm();
				}
			});
		};

		// patch this object, so people can call methods directly
		this[key] = result;

		return result;
	}

	private getSCMResource(uri?: Uri): Resource | undefined {
		uri = uri ? uri : window.activeTextEditor && window.activeTextEditor.document.uri;

		if (!uri) {
			return undefined;
		}

		if (uri.scheme === 'hg') {
			uri = uri.with({ scheme: 'file' });
		}

		if (uri.scheme === 'file') {
			const uriString = uri.toString();

			return this.model.workingDirectoryGroup.getResource(uri)
				|| this.model.stagingGroup.getResource(uri)
				|| this.model.untrackedGroup.getResource(uri)
				|| this.model.mergeGroup.getResource(uri);
		}
	}

	dispose(): void {
		this.disposables.forEach(d => d.dispose());
	}
}