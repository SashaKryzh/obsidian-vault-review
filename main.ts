import {
	App,
	Menu,
	Modal,
	Notice,
	PaneType,
	Plugin,
	PluginSettingTab,
	Setting,
	SuggestModal,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";

type Brand<K, T> = K & { __brand: T };

type VaultReviewSettings = {
	snapshot?: Snapshot;
	settings: Settings;
};

type Snapshot = {
	files: File[];
	createdAt: Date;
};

type File = Brand<
	{
		path: string;
		status: SnapshotFileStatus;
	},
	"File"
>;

type FileStatus = "new" | "to_review" | "reviewed" | "deleted";

type SnapshotFileStatus = Exclude<FileStatus, "new">;

const toFile = (file: File | TFile, status: SnapshotFileStatus): File => {
	return {
		path: file.path,
		status: status,
	} as File;
};

type Settings = {
	showStatusBar: boolean;
};

const DEFAULT_SETTINGS: VaultReviewSettings = {
	settings: {
		showStatusBar: true,
	},
};

export default class VaultReviewPlugin extends Plugin {
	settings: VaultReviewSettings;

	statusBar: StatusBar;

	onload = async () => {
		await this.loadSettings();

		// Ribbon
		this.addRibbonIcon("scan-eye", "Open vault review", () => {
			this.openFileStatusController();
		});

		// Status bar
		this.statusBar = new StatusBar(this.addStatusBarItem(), this);

		// Commands
		this.addCommand({
			id: "open-random-file",
			name: "Open random not reviewed file",
			callback: () => {
				this.openRandomFile();
			},
		});
		this.addCommand({
			id: "complete-review",
			name: "Review file",
			checkCallback: (checking) => {
				if (checking) {
					return this.getActiveFileStatus() === "to_review";
				}

				this.completeReview();
			},
		});
		this.addCommand({
			id: "complete-review-and-open-next",
			name: "Review file and open next random file",
			checkCallback: (checking) => {
				if (checking) {
					return this.getActiveFileStatus() === "to_review";
				}

				this.completeReview({ openNext: true });
			},
		});
		this.addCommand({
			id: "unreview-file",
			name: "Unreview file",
			checkCallback: (checking) => {
				if (checking) {
					return this.getActiveFileStatus() === "reviewed";
				}

				this.unreviewFile();
			},
		});

		// Settings
		this.addSettingTab(new VaultReviewSettingTab(this.app, this));

		// Events
		this.registerEvent(this.app.vault.on("rename", this.handleFileRename));
		this.registerEvent(this.app.vault.on("delete", this.handleFileDelete));
		this.registerEvent(
			this.app.workspace.on("file-open", this.statusBar.update)
		);
	};

	onunload = () => {};

	loadSettings = async () => {
		console.log("loadSettings");
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

		if (typeof this.settings.snapshot?.createdAt === "string") {
			this.settings.snapshot.createdAt = new Date(
				this.settings.snapshot.createdAt
			);
		}
	};

	saveSettings = async () => {
		console.log("Save settings");
		await this.saveData(this.settings);
	};

	onExternalSettingsChange = () => {
		console.log("External settings change detected");
		this.loadSettings();
	};

	getActiveFile = (): TFile | null => {
		const activeFile = this.app.workspace.getActiveFile();
		if (activeFile?.extension !== "md") {
			return null;
		}
		return activeFile;
	};

	getSnapshotFile = (path?: string) => {
		path = path ?? this.getActiveFile()?.path;
		if (!path) {
			return;
		}

		return this.settings.snapshot?.files.find((f) => f.path === path);
	};

	getActiveFileStatus = (): FileStatus | undefined => {
		const activeFile = this.getActiveFile();
		if (!activeFile) {
			return;
		}

		return this.getSnapshotFile(activeFile.path)?.status ?? "new";
	};

	getToReviewFiles = () => {
		return (
			this.settings.snapshot?.files.filter(
				(file) => file.status === "to_review"
			) ?? []
		);
	};

	openFileStatusController = () => {
		if (!this.settings.snapshot) {
			new Notice("Vault review snapshot is not created");
			return;
		}

		new FileStatusControllerModal(this.app, this).open();
	};

	openRandomFile = () => {
		if (!this.settings.snapshot) {
			new Notice("Vault review snapshot is not created");
			return;
		}

		const files = this.getToReviewFiles();
		if (!files.length) {
			new Notice("All files are reviewed");
			return;
		}

		const randomFile = files[Math.floor(Math.random() * files.length)];
		this.focusFile(randomFile, false);
	};

	private focusFile = async (file: File, newLeaf: boolean | PaneType) => {
		const targetFile = this.app.vault.getFileByPath(file.path);

		if (targetFile) {
			const leaf = this.app.workspace.getLeaf(newLeaf);
			leaf.openFile(targetFile);
		} else {
			new Notice("Cannot find a file " + file.path);
			if (this.settings.snapshot) {
				this.settings.snapshot.files = this.settings.snapshot.files.filter(
					(fp) => fp.path !== file.path
				);
				this.statusBar.update();
				await this.saveSettings();
			}
		}
	};

	completeReview = async ({
		file,
		openNext = false,
	}: {
		file?: File;
		openNext?: boolean;
	} = {}) => {
		const activeFile = file ?? this.getActiveFile();
		if (!activeFile) {
			return;
		}

		const snapshotFile = this.getSnapshotFile(activeFile.path);

		if (!snapshotFile) {
			new Notice("File was added to snapshot and marked as reviewed");
			this.settings.snapshot?.files.push(toFile(activeFile, "reviewed"));
		} else {
			snapshotFile.status = "reviewed";
		}

		if (openNext) {
			this.openRandomFile();
		}

		this.statusBar.update();
		await this.saveSettings();
	};

	unreviewFile = async (file?: File) => {
		const activeFile = file ?? this.getActiveFile();
		if (!activeFile) {
			return;
		}

		const snapshotFile = this.getSnapshotFile(activeFile.path);

		if (!snapshotFile) {
			new Notice("File was added to snapshot and marked as not reviewed");
			this.settings.snapshot?.files.push(toFile(activeFile, "to_review"));
		} else {
			snapshotFile.status = "to_review";
		}

		this.statusBar.update();
		await this.saveSettings();
	};

	public deleteSnapshot = async ({
		askForConfirmation = true,
	}: {
		askForConfirmation?: boolean;
	} = {}) => {
		let resolve: (value: DeleteSnapshotResult) => void;
		const completer = new Promise<DeleteSnapshotResult>(
			(r, _) => (resolve = r)
		);

		const onDelete = async () => {
			this.settings.snapshot = undefined;
			this.statusBar.update();
			await this.saveSettings();
			resolve("deleted");
		};

		const onCancel = async () => {
			resolve("cancelled");
		};

		if (askForConfirmation) {
			new ConfirmSnapshotDeleteModal(this.app, onDelete, onCancel).open();
		} else {
			onDelete();
		}

		return completer;
	};

	private handleFileRename = async (file: TAbstractFile, oldPath: string) => {
		if (file instanceof TFolder) {
			return;
		}

		const snapshotFile = this.getSnapshotFile(oldPath);
		if (snapshotFile) {
			snapshotFile.path = file.path;
			await this.saveSettings();
		}
	};

	private handleFileDelete = async (file: TAbstractFile) => {
		if (file instanceof TFolder || !this.settings.snapshot) {
			return;
		}

		const snapshotFile = this.getSnapshotFile(file.path);
		if (snapshotFile) {
			snapshotFile.status = "deleted";
			this.statusBar.update();
			await this.saveSettings();
		}
	};
}

class StatusBar {
	element: HTMLElement;
	plugin: VaultReviewPlugin;

	isReviewed = false;

	constructor(element: HTMLElement, plugin: VaultReviewPlugin) {
		this.element = element;
		this.plugin = plugin;

		element.createSpan("status").setText("Not reviewed");
		element.addClass("mod-clickable");
		element.addEventListener("click", this.onClick);

		this.update();
	}

	update = () => {
		if (!this.plugin.settings.snapshot) {
			this.setIsVisible(false);
			return;
		}

		const activeFileStatus = this.plugin.getActiveFileStatus();
		if (!activeFileStatus || activeFileStatus === "deleted") {
			this.setIsVisible(false);
			return;
		}

		this.setIsVisible(this.plugin.settings.settings.showStatusBar);
		this.isReviewed = activeFileStatus === "reviewed";

		if (activeFileStatus === "new") {
			this.setText("New file");
		} else if (activeFileStatus === "to_review") {
			this.setText("Not reviewed");
		} else if (activeFileStatus === "reviewed") {
			this.setText("Reviewed");
		} else {
			this.setText("");
		}
	};

	private onClick = (event: MouseEvent) => {
		const menu = new Menu();

		menu.addItem((item) => {
			item.setTitle("Reviewed");
			item.setChecked(this.isReviewed);
			item.onClick(() => this.plugin.completeReview());
		});
		menu.addItem((item) => {
			item.setTitle("Not reviewed");
			item.setChecked(!this.isReviewed);
			item.onClick(() => this.plugin.unreviewFile());
		});

		menu.showAtMouseEvent(event);
	};

	private setText = (text: string) => {
		this.element.getElementsByClassName("status")[0].setText(text);
	};

	private setIsVisible = (isVisible: boolean) => {
		if (!this.plugin.settings.snapshot) {
			this.element.style.display = "none";
		} else {
			this.element.style.display = isVisible ? "inline-flex" : "none";
		}
	};
}

class VaultReviewSettingTab extends PluginSettingTab {
	plugin: VaultReviewPlugin;

	constructor(app: App, plugin: VaultReviewPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		const snapshot = this.plugin.settings.snapshot;

		// Main action
		const settingEl = new Setting(containerEl)
			.setName("Snapshot")
			.setDesc(
				snapshot?.createdAt
					? `Snapshot created on ${snapshot?.createdAt.toLocaleDateString()}.`
					: "Create a snapshot of the vault."
			);
		if (snapshot) {
			settingEl.addButton((btn) => {
				btn.setIcon("trash");
				btn.setWarning();
				btn.onClick(async () => {
					await this.plugin.deleteSnapshot();
					this.display();
				});
			});
			settingEl.addButton((btn) => {
				btn.setButtonText("Add all new files to snapshot").onClick(async () => {
					const vaultFiles = this.plugin.app.vault
						.getMarkdownFiles()
						.filter(
							(file) =>
								!this.plugin.settings.snapshot?.files.some(
									(f) => f.path === file.path
								)
						)
						.map((file) => toFile(file, "to_review"));
					this.plugin.settings.snapshot?.files.push(...vaultFiles);
					this.plugin.statusBar.update();
					this.display();
					await this.plugin.saveSettings();
				});
			});
		} else {
			settingEl.addButton((btn) => {
				btn.setButtonText("Create snapshot");
				btn.setCta();
				btn.onClick(async () => {
					const files = this.plugin.app.vault
						.getMarkdownFiles()
						.map((file) => toFile(file, "to_review"));
					this.plugin.settings.snapshot = {
						files,
						createdAt: new Date(),
					};
					this.plugin.statusBar.update();
					this.display();
					await this.plugin.saveSettings();
				});
			});
		}

		// Snapshot info
		if (snapshot) {
			containerEl.createDiv("snapshot-info", (div) => {
				const allFilesLength = this.plugin.app.vault.getMarkdownFiles().length;
				const snapshotFilesLength = snapshot.files.length;
				const deletedFilesLength = snapshot.files.filter(
					(file) => file.status === "deleted"
				).length;
				const notInSnapshotLength =
					allFilesLength - snapshotFilesLength + deletedFilesLength;
				const reviewedFilesLength = snapshot.files.filter(
					(file) => file.status === "reviewed"
				).length;
				const toReviewFilesLength =
					snapshotFilesLength - reviewedFilesLength - deletedFilesLength;

				const percentSnapshotCompleted = Math.round(
					(reviewedFilesLength / (snapshotFilesLength - deletedFilesLength)) *
						100
				);
				const percentSnapshotDeleted = Math.round(
					(deletedFilesLength / snapshotFilesLength) * 100
				);

				div.createEl("p").setText(`Markdown files in vault: ${allFilesLength}`);

				const inSnapshotEl = div.createEl("p", "in-snapshot");
				inSnapshotEl
					.createSpan()
					.setText(`In snapshot: ${snapshotFilesLength}`);
				inSnapshotEl.createSpan().setText(`To review: ${toReviewFilesLength}`);
				inSnapshotEl
					.createSpan()
					.setText(
						`Reviewed: ${reviewedFilesLength} (${percentSnapshotCompleted}%)`
					);
				inSnapshotEl
					.createSpan()
					.setText(
						`Deleted: ${deletedFilesLength} (${percentSnapshotDeleted}%)`
					);

				div.createEl("p").setText(`Not in snapshot: ${notInSnapshotLength}`);
			});
		}

		new Setting(containerEl)
			.setName("Status bar")
			.setDesc("Show file review status in the status bar.")
			.addToggle((toggle) => {
				toggle.setValue(this.plugin.settings.settings.showStatusBar);
				toggle.onChange(async (value) => {
					this.plugin.settings.settings.showStatusBar = value;
					this.plugin.statusBar.update();
					await this.plugin.saveSettings();
				});
			});
	}
}

type DeleteSnapshotResult = "deleted" | "cancelled";

export class ConfirmSnapshotDeleteModal extends Modal {
	constructor(
		app: App,
		onDelete: () => Promise<void> | void,
		onCancel: () => Promise<void> | void
	) {
		super(app);

		this.setTitle("Delete snapshot?");

		new Setting(this.contentEl)
			.setName("This action cannot be undone")
			.setDesc(
				"You will lose all progress and will need to create a new snapshot."
			)
			.addButton((btn) => {
				btn.setButtonText("Cancel");
				btn.onClick(async () => {
					await onCancel();
					this.close();
				});
			})
			.addButton((btn) => {
				btn.setButtonText("Delete");
				btn.setWarning();
				btn.onClick(async () => {
					await onDelete();
					this.close();
				});
			});
	}
}

const ACTIONS = {
	open_random: {
		name: "Open random not reviewed file",
	},
	review: {
		name: "Review file",
	},
	review_and_next: {
		name: "Review file and open next random file",
	},
	unreview: {
		name: "Unreview file",
	},
} as const;

type Action = keyof typeof ACTIONS;

class FileStatusControllerModal extends SuggestModal<Action> {
	plugin: VaultReviewPlugin;

	constructor(app: App, plugin: VaultReviewPlugin) {
		super(app);
		this.plugin = plugin;

		const fileStatus = this.plugin.getActiveFileStatus();
		this.setPlaceholder(
			!fileStatus
				? ""
				: fileStatus === "new"
				? "This file is not in snapshot"
				: fileStatus === "to_review"
				? "This file is not reviewed"
				: "This file is reviewed"
		);
	}

	getSuggestions = (query: string): Action[] => {
		const activeFile = this.plugin.getActiveFile();
		let actions: Action[] = [];

		if (!activeFile) {
			actions = ["open_random"];
		} else {
			const isReviewed =
				this.plugin.getSnapshotFile(activeFile.path)?.status === "reviewed";

			if (isReviewed) {
				actions = ["open_random", "unreview"];
			} else {
				actions = ["review_and_next", "review", "open_random"];
			}
		}

		return actions.filter((a) =>
			ACTIONS[a].name.toLowerCase().includes(query.toLowerCase())
		);
	};

	renderSuggestion = (action: Action, el: HTMLElement) => {
		el.createEl("div", { text: ACTIONS[action].name });
	};

	onChooseSuggestion = (action: Action, evt: MouseEvent | KeyboardEvent) => {
		if (action === "open_random") {
			this.plugin.openRandomFile();
		}

		if (action === "review") {
			this.plugin.completeReview();
		}

		if (action === "review_and_next") {
			this.plugin.completeReview({ openNext: true });
		}

		if (action === "unreview") {
			this.plugin.unreviewFile();
		}
	};
}
