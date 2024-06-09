import React, { useEffect, useState } from 'react';

const OpenTab = ({ tab }) => {
    const closeBtnHandler = () => {
        chrome.tabs.remove(tab.id);
    }
    return (
        <div style={{
            display: 'flex'
        }}>
            <span>{tab.title}</span> <button onClick={closeBtnHandler}>X</button>
        </div>
    );
};

export default OpenTab;
