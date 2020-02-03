import https from 'https';
import http from 'http';

import { Meteor } from 'meteor/meteor';
import { Random } from 'meteor/random';

import {
	Base,
	ProgressStep,
	Selection,
} from '../../importer/server';
import { Messages } from '../../models';
import { FileUpload } from '../../file-upload';

export class SlackImageImporter extends Base {
	constructor(info, importRecord) {
		super(info, importRecord);
		this.userTags = [];
		this.bots = {};
	}

	prepareImageCount() {
		this.logger.debug('start preparing import operation');
		super.updateProgress(ProgressStep.PREPARING_STARTED);

		const messages = Messages.findAllSlackImportedMessagesWithFilesToDownload();
		const imageCount = messages.count();

		if (imageCount === 0) {
			super.updateProgress(ProgressStep.DONE);
			return 0;
		}

		this.updateRecord({ 'count.messages': imageCount, messagesstatus: null });
		this.addCountToTotal(imageCount);

		const fileData = new Selection(this.name, [], [], imageCount);
		this.updateRecord({ fileData });

		super.updateProgress(ProgressStep.IMPORTING_IMAGES);
		Meteor.defer(() => {
			this.startImport(fileData);
		});

		return imageCount;
	}

	startImport() {
		const slackFileMessageList = Messages.findAllSlackImportedMessagesWithFilesToDownload();
		const downloadedFileIds = [];
		const maxFileCount = 10;
		const maxFileSize = 1024 * 1024 * 500;

		let count = 0;
		let currentSize = 0;
		let nextSize = 0;

		const waitForFiles = () => {
			if ((count + 1) < maxFileCount && (currentSize + nextSize) < maxFileSize) {
				return;
			}

			Meteor.wrapAsync((callback) => {
				const handler = setInterval(() => {
					if ((count + 1) >= maxFileCount) {
						return;
					}

					if (currentSize + nextSize >= maxFileSize && count > 0) {
						return;
					}

					clearInterval(handler);
					callback();
				}, 1000);
			})();
		};

		const completeFile = (details) => {
			this.addCountCompleted(1);
			count--;
			currentSize -= details.size;
		};

		const logError = (error) => {
			this.logger.error(error);
		};

		try {
			slackFileMessageList.forEach((message) => {
				try {
					const { slackFile } = message;
					if (!slackFile || slackFile.downloaded || downloadedFileIds.includes(slackFile.id)) {
						this.addCountCompleted(1);
						return;
					}

					const url = slackFile.url_private_download;
					if (!url || !url.startsWith('http')) {
						this.addCountCompleted(1);
						return;
					}

					const details = {
						message_id: `${ message._id }-file-${ slackFile.id }`,
						name: slackFile.name || Random.id(),
						size: slackFile.size || 0,
						userId: message.u._id,
						rid: message.rid,
					};

					const requestModule = /https/i.test(url) ? https : http;
					const fileStore = FileUpload.getStore('Uploads');
					const addCountCompleted = this.addCountCompleted.bind(this);

					nextSize = details.size;
					waitForFiles();
					count++;
					currentSize += nextSize;

					requestModule.get(url, Meteor.bindEnvironment(function(res) {
						const contentType = res.headers['content-type'];
						if (!details.type && contentType) {
							details.type = contentType;
						}

						const rawData = [];
						res.on('data', Meteor.bindEnvironment((chunk) => {
							rawData.push(chunk);

							// Update progress more often on large files
							addCountCompleted(0);
						}));
						res.on('error', Meteor.bindEnvironment((error) => {
							completeFile(details);
							logError(error);
						}));

						res.on('end', Meteor.bindEnvironment(() => {
							try {
								// Bypass the fileStore filters
								fileStore._doInsert(details, Buffer.concat(rawData), function(error, file) {
									if (error) {
										completeFile(details);
										logError(error);
										return;
									}

									const url = FileUpload.getPath(`${ file._id }/${ encodeURI(file.name) }`);
									const attachment = {
										title: file.name,
										title_link: url,
									};

									if (/^image\/.+/.test(file.type)) {
										attachment.image_url = url;
										attachment.image_type = file.type;
										attachment.image_size = file.size;
										attachment.image_dimensions = file.identify != null ? file.identify.size : undefined;
									}

									if (/^audio\/.+/.test(file.type)) {
										attachment.audio_url = url;
										attachment.audio_type = file.type;
										attachment.audio_size = file.size;
									}

									if (/^video\/.+/.test(file.type)) {
										attachment.video_url = url;
										attachment.video_type = file.type;
										attachment.video_size = file.size;
									}

									Messages.setSlackFileRocketChatAttachment(slackFile.id, url, attachment);
									downloadedFileIds.push(slackFile.id);
									completeFile(details);
								});
							} catch (error) {
								completeFile(details);
								logError(error);
							}
						}));
					}));
				} catch (error) {
					this.logger.error(error);
				}
			});
		} catch (error) {
			// If the cursor expired, restart the method
			if (error && error.codeName === 'CursorNotFound') {
				return this.startImport();
			}

			super.updateProgress(ProgressStep.ERROR);
			throw error;
		}

		super.updateProgress(ProgressStep.DONE);
		return this.getProgress();
	}
}