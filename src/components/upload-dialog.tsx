import React, { useCallback } from 'react';
import { useDispatch } from '../frontend-utils';
import { useShallowEqualSelector } from '../frontend-utils';

import { actions as uploadDialogActions } from '../redux/upload-dialog-feature';

import Dialog from '@mui/material/Dialog';
import DialogActions from '@mui/material/DialogActions';
import DialogContent from '@mui/material/DialogContent';
import DialogContentText from '@mui/material/DialogContentText';
import DialogTitle from '@mui/material/DialogTitle';
import Slide, { SlideProps } from '@mui/material/Slide';
import Button from '@mui/material/Button';
import LinearProgress from '@mui/material/LinearProgress';
import Box from '@mui/material/Box';
import Checkbox from '@mui/material/Checkbox';
import FormControlLabel from '@mui/material/FormControlLabel';
import { makeStyles } from 'tss-react/mui';
import { W95UploadDialog } from './win95/upload-dialog';
import { setNotifyWhenFinished } from '../redux/actions';

const useStyles = makeStyles()((theme) => ({
    progressPerc: {
        marginTop: theme.spacing(1),
        display: 'flex',
    },
    progressBar: {
        marginTop: theme.spacing(3),
    },
    uploadLabel: {
        marginTop: theme.spacing(3),
    },
    spacer: {
        flex: '1 1 auto',
    },
    checkBox: {
        marginLeft: 0,
    },
}));

const Transition = React.forwardRef(function Transition(props: SlideProps, ref: React.Ref<unknown>) {
    return <Slide direction="up" ref={ref} {...props} />;
});

export const UploadDialog = (props: {}) => {
    const { classes } = useStyles();
    const dispatch = useDispatch();

    const {
        visible,
        cancelled,
        writtenProgress,
        encryptedProgress,
        totalProgress,

        trackTotal,
        trackCurrent,
        trackConverting,
        titleCurrent,
        titleConverting,

        trackEncodeProgress,
        trackEncodeProgressOutOf,
        conversionStepName,
        discAtOnceStage,
    } = useShallowEqualSelector((state) => state.uploadDialog);
    const { vintageMode, notifyWhenFinished, hasNotificationSupport } = useShallowEqualSelector((state) => state.appState);

    const handleCancelUpload = useCallback(() => {
        dispatch(uploadDialogActions.setCancelUpload(true));
    }, [dispatch]);

    const handleNotifyWhenFinishedChanged = useCallback(() => {
        dispatch(setNotifyWhenFinished(!notifyWhenFinished));
    }, [dispatch, notifyWhenFinished]);

    const progressValue = Math.floor((writtenProgress / totalProgress) * 100);
    const bufferValue = Math.floor((encryptedProgress / totalProgress) * 100);
    const convertedValue = Math.floor((trackConverting / trackTotal) * 100);
    const currentTrackConversionProgress =
        trackEncodeProgressOutOf === 0 ? undefined : Math.floor((trackEncodeProgress / trackEncodeProgressOutOf) * 100);

    let conversionLabel =
        convertedValue === 100 && trackConverting === trackTotal
            ? `Conversion completed`
            : `Converting ${trackConverting + 1} of ${trackTotal}: ${titleConverting}`;
    let uploadLabel = `Uploading ${trackCurrent} of ${trackTotal}: ${titleCurrent}`;
    let uploadIndeterminate = false;
    // Disc at Once converts every track first, then records them as a single recording and splits it afterwards
    if (discAtOnceStage === 'decoding') {
        if (!(convertedValue === 100 && trackConverting === trackTotal)) {
            conversionLabel = `Decoding ${trackConverting + 1} of ${trackTotal}: ${titleConverting}`;
        }
        uploadLabel = `Disc at Once: recording starts once all ${trackTotal} tracks are ready`;
    } else if (discAtOnceStage === 'encoding') {
        conversionLabel = `Encoding all ${trackTotal} tracks as one continuous stream`;
        uploadLabel = `Disc at Once: recording starts once encoding is done`;
    } else if (discAtOnceStage === 'uploading') {
        conversionLabel = `Conversion completed`;
        uploadLabel = `Recording all ${trackTotal} tracks as one recording`;
    } else if (discAtOnceStage === 'splitting') {
        conversionLabel = `Conversion completed`;
        uploadLabel = `Splitting the recording into ${trackTotal} tracks (writing the ToC, this takes about a minute)`;
        uploadIndeterminate = true;
    }
    const canCancel = !cancelled && discAtOnceStage !== 'uploading' && discAtOnceStage !== 'splitting';

    if (vintageMode) {
        const p = {
            visible,
            cancelled,
            writtenProgress,
            encryptedProgress,
            totalProgress,

            trackTotal,
            trackCurrent,
            trackConverting,
            titleCurrent,
            titleConverting,

            handleCancelUpload,
            progressValue,
            bufferValue,
            convertedValue,
            notifyWhenFinished,
            hasNotificationSupport,
            handleNotifyWhenFinishedChanged,
            conversionLabel,
            conversionProgress: currentTrackConversionProgress ?? convertedValue,
            uploadLabel,
            canCancel,
        };
        return <W95UploadDialog {...p} />;
    }
    return (
        <Dialog
            open={visible}
            maxWidth={'sm'}
            fullWidth={true}
            TransitionComponent={Transition as any}
            aria-labelledby="upload-dialog-slide-title"
            aria-describedby="upload-dialog-slide-description"
        >
            <DialogTitle id="upload-dialog-slide-title">Recording...</DialogTitle>
            <DialogContent>
                <DialogContentText id="upload-dialog-slide-description">
                    {conversionLabel}
                </DialogContentText>

                <LinearProgress
                    className={classes.progressBar}
                    variant={(currentTrackConversionProgress ?? convertedValue) === 0 ? 'indeterminate' : 'determinate'}
                    color="primary"
                    value={currentTrackConversionProgress ?? convertedValue}
                />
                <Box className={classes.progressPerc}>
                    <span>{currentTrackConversionProgress ?? convertedValue}%</span>
                    <span style={{flexGrow: 1}} />
                    {conversionStepName}
                </Box>

                <DialogContentText id="upload-dialog-slide-description" className={classes.uploadLabel}>
                    {uploadLabel}
                </DialogContentText>
                {uploadIndeterminate ? (
                    <LinearProgress className={classes.progressBar} variant="indeterminate" color="secondary" />
                ) : (
                    <LinearProgress
                        className={classes.progressBar}
                        variant="buffer"
                        color="secondary"
                        value={progressValue}
                        valueBuffer={bufferValue}
                    />
                )}
                <Box className={classes.progressPerc}>{uploadIndeterminate ? '\u00a0' : `${progressValue}%`}</Box>
            </DialogContent>
            <DialogActions>
                {hasNotificationSupport ? (
                    <FormControlLabel
                        className={classes.checkBox}
                        disabled={!hasNotificationSupport}
                        control={<Checkbox checked={notifyWhenFinished} onChange={handleNotifyWhenFinishedChanged} name="notifyOnEnd" />}
                        label="Notify when completed"
                    />
                ) : null}
                <div className={classes.spacer}></div>
                <Button disabled={!canCancel} onClick={handleCancelUpload}>
                    {cancelled ? `Stopping after current track...` : `Cancel Recording`}
                </Button>
            </DialogActions>
        </Dialog>
    );
};
